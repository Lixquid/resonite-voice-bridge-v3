package main

// Warm model cache: downloads the models that are too large to ship with the
// app into a per-user cache folder and serves them to the frontend over HTTP,
// so the frontend never has to reach an external service itself. The groups
// (see cacheGroups) split into two flavors:
//
//   - Eager, non-Japanese: the small and medium English Moonshine streaming
//     speech models (under /models/<name>/<file>) and the Needle 3 engine
//     (JS + WASM + model blob, under /needle3/<file>). These pre-download on
//     start (see warmModelCache), so they are already cached when the
//     frontend asks for them.
//   - Lazy: the Japanese Moonshine streaming models (small and tiny, served
//     under /models/<name>_ja/<file>) and the browser-side translation
//     engine (Transformers.js and one OPUS-MT model per direction, served
//     under /translation/<file>). These download on demand — when the
//     frontend first requests one of their files (see serveModelCache) — so
//     an unused feature never costs bandwidth.
//
// Every file is downloaded once and kept in the cache folder; subsequent
// starts only fetch what is missing. The cache directory follows the same
// convention as the settings file (see settings.go):
// <UserCacheDir>/resonite-voice-bridge/ (e.g. ~/.cache/resonite-voice-bridge
// on Linux, %LocalAppData%\resonite-voice-bridge on Windows).
//
// The download state of the cache is also reported over HTTP: GET /cache/
// status (see serveCacheStatus) lists every file and every capability group
// (see capabilityGroups) with what is cached so far.
// <UserCacheDir>/resonite-voice-bridge/ (e.g. ~/.cache/resonite-voice-bridge
// on Linux, %LocalAppData%\resonite-voice-bridge on Windows).

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"maps"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// The pinned Moonshine CDN revision the English streaming models come from.
// Bump deliberately, mirroring frontend/scripts/fetch-models.mjs. Vars rather
// than constants so tests can retarget them at a local server.
var (
	moonshineCDNBase = "https://download.moonshine.ai/model"
	moonshineCDNRev  = "quantized_26_07_30"
)

// The pinned Moonshine CDN revision the Japanese streaming models come from.
// Per-language on purpose: Moonshine quantizes each language from its own
// checkpoints on its own day (see kJapaneseStreamingQuantizedDir in the
// Moonshine core catalog), so the revision must never be coupled to the
// English one above. Bump deliberately.
var moonshineCDNJaRev = "quantized_26_08_23"

// The pinned Hugging Face revision of the Needle 3 engine. Must match the
// revision the frontend was built against (see frontend/src/needle.ts).
// Var rather than constant so tests can retarget it at a local server.
var needle3Base = "https://huggingface.co/Cactus-Compute/needle3/resolve/c7c415a3d1b3d929014bc6e866d51ebb971f7089"

// The pinned sources of the browser-side translation engine (the Translation
// Stream, see frontend/src/translate.ts): the Transformers.js library build,
// and one OPUS-MT model per direction. Must match the revisions the frontend
// was built against. These download lazily, when the frontend first requests
// them — translation is off by default (see cacheGroups). Vars rather than
// constants so tests can retarget them at a local server.
const transformersJSVersion = "3.8.1"

// EN → JP: an ONNX export of Helsinki-NLP/opus-tatoeba-en-ja. Preferred over
// the bible-domain Xenova/opus-mt-en-jap, whose output on everyday phrases is
// markedly worse; both are Apache-2.0.
const translationEnJapRev = "225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e"

// JP → EN: the standard OPUS-MT ja-en (Apache-2.0 via Helsinki-NLP).
const translationJaEnRev = "1a906cfaaf7c8f4193f67f5885c082aa6dbd9d16"

var (
	transformersJSBase   = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@" + transformersJSVersion + "/dist"
	translationEnJapBase = "https://huggingface.co/Kadonox/opus-tatoeba-en-ja-onnx/resolve/" + translationEnJapRev
	translationJaEnBase  = "https://huggingface.co/Xenova/opus-mt-ja-en/resolve/" + translationJaEnRev
)

// modelFilesShared lists the canonical filenames every streaming Moonshine
// model needs, regardless of language (the same shared list as
// MODEL_FILES_SHARED in frontend/src/main.ts).
var modelFilesShared = []string{
	"encoder.ort",
	"adapter.ort",
	"cross_kv.ort",
	"decoder_kv.ort",
	"streaming_config.json",
	"tokenizer.bin",
}

// modelFileEn is the English-specific extra: the English graph was exported
// as a single frontend.ort.
var modelFileEn = []string{"frontend.ort"}

// modelFilesJa are the Japanese-specific extras: the Japanese graph was
// exported as a split model/weights pair (frontend.model.ort +
// frontend.weights.ort) rather than the single frontend.ort the English
// export produced, so the Japanese file set is one file larger (see
// MODEL_FILES_JA in frontend/src/main.ts). Only the Japanese models use
// them — the English CDN paths have no such files.
var modelFilesJa = []string{
	"frontend.model.ort",
	"frontend.weights.ort",
}

// modelFilesEn is the full English file set: the shared files plus the
// English export (same list as MODEL_FILES_EN in frontend/src/main.ts).
var modelFilesEn = append(append([]string{}, modelFilesShared...), modelFileEn...)

// jaModelFiles composes the full Japanese file set: the shared files plus
// the split model/weights pair.
func jaModelFiles() []string {
	return append(append([]string{}, modelFilesShared...), modelFilesJa...)
}

// needle3Files are the files the frontend's Needle 3 worker fetches from its
// base URL: the Emscripten engine (JS + WASM) and the model blob.
var needle3Files = []string{
	"wasm/needle.js",
	"wasm/needle.wasm",
	"needle3.cact",
}

// translationLibFiles are the Transformers.js build files the translation
// worker loads: the library itself plus the ONNX Runtime Web backend it
// runs on (only the jsep build exists in the pinned version).
var translationLibFiles = []string{
	"transformers.min.js",
	"ort-wasm-simd-threaded.jsep.mjs",
	"ort-wasm-simd-threaded.jsep.wasm",
}

// translationModelFiles are the model files the frontend's Transformers.js
// loader requests per OPUS-MT direction: the int8 (q8) ONNX graphs — chosen
// over fp16 because they are half the download and faster on the WASM
// backend — plus the configs and fast tokenizer.
var translationModelFiles = []string{
	"config.json",
	"generation_config.json",
	"tokenizer.json",
	"tokenizer_config.json",
	"onnx/encoder_model_quantized.onnx",
	"onnx/decoder_model_merged_quantized.onnx",
}

// URL prefixes the cache is served under (see serveModelCache and
// cacheRelPath). Each prefix maps onto the cache subdirectory of the same
// name, so the served layout mirrors the cache layout (and, for /needle3/,
// the layout the Needle 3 worker expects from its base URL).
const modelsURLPrefix = "/models"
const needleURLPrefix = "/needle3"
const translationURLPrefix = "/translation"

// cachePrefixes pairs each served URL prefix with its cache directory.
var cachePrefixes = []struct{ url, dir string }{
	{modelsURLPrefix, "models"},
	{needleURLPrefix, "needle3"},
	{translationURLPrefix, "translation"},
}

// A capability group: one feature of the app, named by the cache groups
// (see cacheGroups) whose files it needs. This is the feature-facing view of
// the cache, reported by the /cache/status endpoint (see serveCacheStatus).
type capabilityGroup struct {
	id   string
	dirs []string
}

// capabilityGroups maps every feature onto the cache groups its files come
// from. The groups (every cache group belongs to exactly one capability):
//
//   - shared: the Transformers.js library build with its ONNX Runtime Web
//     backend, the runtime both the Moonshine streaming models and the
//     OPUS-MT translation models run on — everything except Needle 3.
//   - english-stt: the small and medium English Moonshine streaming models.
//   - japanese-stt: the small and tiny Japanese Moonshine streaming models.
//   - tool-calling: the Needle 3 engine (its own Emscripten WASM runtime,
//     independent of the Transformers.js stack).
//   - translate-en-ja and translate-ja-en: one OPUS-MT model per direction.
func capabilityGroups() []capabilityGroup {
	return []capabilityGroup{
		{id: "shared", dirs: []string{filepath.Join("translation", "lib")}},
		{
			id: "english-stt",
			dirs: []string{
				filepath.Join("models", "small_streaming"),
				filepath.Join("models", "medium_streaming"),
			},
		},
		{
			id: "japanese-stt",
			dirs: []string{
				filepath.Join("models", "small_streaming_ja"),
				filepath.Join("models", "tiny_streaming_ja"),
			},
		},
		{id: "tool-calling", dirs: []string{"needle3"}},
		{id: "translate-en-ja", dirs: []string{filepath.Join("translation", "models", "opus-tatoeba-en-ja")}},
		{id: "translate-ja-en", dirs: []string{filepath.Join("translation", "models", "opus-mt-ja-en")}},
	}
}

// The JSON status endpoint (see serveCacheStatus).
const cacheStatusPath = "/cache/status"

// cacheFileStatus is the download status of one cached file: its
// cache-relative slash path, the URL it is served under, whether it is fully
// cached (a non-empty file exists — the same test the downloaders use), its
// size in bytes (0 when not cached), and — while the backend is downloading
// it right now — the live progress: downloading is true, received counts the
// bytes fetched so far and total the size the server declared (0 when it did
// not declare one).
type cacheFileStatus struct {
	Path        string `json:"path"`
	URL         string `json:"url"`
	Cached      bool   `json:"cached"`
	Size        int64  `json:"size"`
	Downloading bool   `json:"downloading"`
	Received    int64  `json:"received"`
	Total       int64  `json:"total"`
}

// cacheGroupStatus is the download status of one capability group: the
// statuses of its files (in cache-group file order), the count of cached
// files, the total file count, and whether every file is cached (the
// capability is usable offline without a download). The byte sums drive the
// frontend's progress bar: cached files count their size on both sides, a
// downloading file counts its live received bytes and declared total, and a
// file never requested yet (size unknown until its download starts) is left
// out of both sums.
type cacheGroupStatus struct {
	ID               string            `json:"id"`
	Files            []cacheFileStatus `json:"files"`
	CachedFiles      int               `json:"cachedFiles"`
	TotalFiles       int               `json:"totalFiles"`
	DownloadingFiles int               `json:"downloadingFiles"`
	ReceivedBytes    int64             `json:"receivedBytes"`
	TotalBytes       int64             `json:"totalBytes"`
	Ready            bool              `json:"ready"`
}

// cacheStatusReport is the whole /cache/status response: every individual
// file (sorted by path, for stable output) and every capability group.
type cacheStatusReport struct {
	Files  []cacheFileStatus  `json:"files"`
	Groups []cacheGroupStatus `json:"groups"`
}

// A cache-download group: a cache-relative directory, the pinned remote base
// URL its files are fetched from, the files within it, and whether the group
// is eager. The cache layout mirrors the served URL layout (models/… under
// /models/, needle3/… under /needle3/, translation/… under /translation/).
//
// Eager groups hold every non-Japanese asset: they pre-download on start
// (see warmModelCache), so the files are already cached when the frontend
// asks for them. Lazy groups — the Japanese streaming models and the
// translation engine — download on demand, the first time the frontend
// requests one of their files: Japanese is a secondary target language and
// translation is off by default, so neither should cost bandwidth when
// unused. Eager groups also download on demand if a startup download
// failed, so a transient network error cannot leave a file permanently
// missing.
type cacheGroup struct {
	dir   string
	base  string
	files []string
	eager bool
}

// cacheGroups lists every downloadable group. Bases are read on every call:
// tests retarget them at a local server (see the vars above).
func cacheGroups() []cacheGroup {
	return []cacheGroup{
		// Eager, non-Japanese: pre-downloaded on start.
		{
			dir:   filepath.Join("models", "small_streaming"),
			base:  moonshineCDNBase + "/small-streaming-en/" + moonshineCDNRev,
			files: modelFilesEn,
			eager: true,
		},
		{
			dir:   filepath.Join("models", "medium_streaming"),
			base:  moonshineCDNBase + "/medium-streaming-en/" + moonshineCDNRev,
			files: modelFilesEn,
			eager: true,
		},
		{
			dir:   "needle3",
			base:  needle3Base,
			files: needle3Files,
			eager: true,
		},
		// Lazy, Japanese: downloaded when the frontend requests them.
		{
			dir:   filepath.Join("models", "small_streaming_ja"),
			base:  moonshineCDNBase + "/small-streaming-ja/" + moonshineCDNJaRev,
			files: jaModelFiles(),
		},
		{
			dir:   filepath.Join("models", "tiny_streaming_ja"),
			base:  moonshineCDNBase + "/tiny-streaming-ja/" + moonshineCDNJaRev,
			files: jaModelFiles(),
		},
		// Lazy, translation engine: downloaded when the frontend requests
		// them (translation is off by default).
		{
			dir:   filepath.Join("translation", "lib"),
			base:  transformersJSBase,
			files: translationLibFiles,
		},
		{
			dir:   filepath.Join("translation", "models", "opus-tatoeba-en-ja"),
			base:  translationEnJapBase,
			files: translationModelFiles,
		},
		{
			dir:   filepath.Join("translation", "models", "opus-mt-ja-en"),
			base:  translationJaEnBase,
			files: translationModelFiles,
		},
	}
}

// cacheFileURL maps a cache-relative slash path back to the served URL it is
// available under — the inverse of cacheRelPath. Only paths inside a served
// prefix have a URL; anything else returns the empty string.
func cacheFileURL(rel string) string {
	for _, prefix := range cachePrefixes {
		if strings.HasPrefix(rel, prefix.dir+"/") {
			return prefix.url + strings.TrimPrefix(rel, prefix.dir)
		}
	}
	return ""
}

// fileStatus inspects one cache-relative slash path in the cache directory.
// A zero-size file counts as not cached, mirroring the downloader (see
// downloadGroup: a truncated file is retried, never served). An in-flight
// download of the file (see downloadProgressOf) overrides the absence: the
// status reports the live byte progress instead of a bare "not cached".
func fileStatus(rel string) cacheFileStatus {
	status := cacheFileStatus{Path: rel, URL: cacheFileURL(rel)}
	if info, err := os.Stat(filepath.Join(cacheDir(), filepath.FromSlash(rel))); err == nil && !info.IsDir() && info.Size() > 0 {
		status.Cached = true
		status.Size = info.Size()
		status.Total = info.Size()
		return status
	}
	if received, total, ok := downloadProgressOf(rel); ok {
		status.Downloading = true
		status.Received = received
		status.Total = total
	}
	return status
}

// serveCacheStatus answers GET " + cacheStatusPath with a JSON report of what
// is downloaded: one entry per individual file (see cacheFileStatus) and one
// per capability group (see cacheGroupStatus). It returns false for anything
// else — other paths and methods fall through to the caller's next handler.
func serveCacheStatus(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != cacheStatusPath || r.Method != http.MethodGet {
		return false
	}
	// One status lookup per distinct file: the flat report and the group
	// reports share the same entries, and a path is never inspected twice.
	statuses := map[string]cacheFileStatus{}
	for _, group := range cacheGroups() {
		for _, name := range group.files {
			rel := group.dir + "/" + name
			if _, ok := statuses[rel]; !ok {
				statuses[rel] = fileStatus(rel)
			}
		}
	}
	report := cacheStatusReport{Files: []cacheFileStatus{}, Groups: []cacheGroupStatus{}}
	for _, rel := range slices.Sorted(maps.Keys(statuses)) {
		report.Files = append(report.Files, statuses[rel])
	}
	for _, capability := range capabilityGroups() {
		gs := cacheGroupStatus{ID: capability.id, Files: []cacheFileStatus{}}
		for _, dir := range capability.dirs {
			for _, group := range cacheGroups() {
				if group.dir != dir {
					continue
				}
				for _, name := range group.files {
					st := statuses[dir+"/"+name]
					gs.Files = append(gs.Files, st)
					gs.TotalFiles++
					if st.Cached {
						gs.CachedFiles++
						gs.ReceivedBytes += st.Size
						gs.TotalBytes += st.Size
					} else if st.Downloading {
						gs.DownloadingFiles++
						gs.ReceivedBytes += st.Received
						gs.TotalBytes += st.Total
					}
				}
			}
		}
		gs.Ready = gs.TotalFiles > 0 && gs.CachedFiles == gs.TotalFiles
		report.Groups = append(report.Groups, gs)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(report); err != nil {
		log.Printf("Cache status: cannot encode response: %v", err)
	}
	return true
}

// groupFileURL looks up one cache-relative slash path among the groups' file
// sets and returns the pinned remote URL it comes from. Only approved files
// are ever served or downloaded; anything else (ok == false) is refused — a
// request must not be able to make the server fetch arbitrary URLs.
func groupFileURL(rel string) (url string, ok bool) {
	for _, group := range cacheGroups() {
		if !strings.HasPrefix(rel, group.dir+"/") {
			continue
		}
		name := strings.TrimPrefix(rel, group.dir+"/")
		for _, file := range group.files {
			if file == name {
				return group.base + "/" + name, true
			}
		}
	}
	return "", false
}

// Per-file locks so concurrent requests for the same missing asset download
// it once instead of racing (guarded by fileLocksMu).
var (
	fileLocksMu sync.Mutex
	fileLocks   = map[string]*sync.Mutex{}
)

// fileLock returns the download lock for one cache-relative path.
func fileLock(rel string) *sync.Mutex {
	fileLocksMu.Lock()
	defer fileLocksMu.Unlock()
	mu, ok := fileLocks[rel]
	if !ok {
		mu = &sync.Mutex{}
		fileLocks[rel] = mu
	}
	return mu
}

// serveIfCached serves full when it exists as a file, reporting whether it did.
func serveIfCached(w http.ResponseWriter, r *http.Request, full string) bool {
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		return false
	}
	serveCacheFile(w, r, full)
	return true
}

// serveCacheFile serves one cache file, pinning the content type for
// extensions the platform's MIME database gets wrong (see mimeOverrides in
// server.go; .wasm is pinned too because some registries lack it entirely).
// The response is marked no-cache: the browser must revalidate every use
// against this server, whose on-disk cache folder is the single source of
// truth. Without it a browser could serve heuristically-fresh stale bytes
// across app updates (or after --clear-cache), which the model loader would
// then take as valid — the same failure shape its own Cache Storage already
// invites (see resolveModelUrls in frontend/src/main.ts).
func serveCacheFile(w http.ResponseWriter, r *http.Request, full string) {
	ext := strings.ToLower(filepath.Ext(full))
	if ct, ok := mimeOverrides[ext]; ok {
		w.Header().Set("Content-Type", ct)
	} else if ext == ".wasm" {
		w.Header().Set("Content-Type", "application/wasm")
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, full)
}

// Cache directory resolution: computed once. testCacheDir, when non-empty,
// short-circuits the real resolution (tests only).
var (
	cacheDirOnce sync.Once
	cacheDirPath string
	testCacheDir string
)

// cacheDir returns the root of the model cache directory.
func cacheDir() string {
	if testCacheDir != "" {
		return testCacheDir
	}
	cacheDirOnce.Do(func() {
		base, err := os.UserCacheDir()
		if err != nil {
			// No user cache directory (rare): fall back to the temporary
			// directory so the app still works, redownloading every start.
			base = os.TempDir()
		}
		cacheDirPath = filepath.Join(base, "resonite-voice-bridge")
	})
	return cacheDirPath
}

// setCacheDirForTest points the cache at an arbitrary directory.
func setCacheDirForTest(dir string) {
	testCacheDir = dir
}

// clearCache deletes the whole per-user model cache folder (and recreates it
// empty), so warmModelCache re-downloads everything from scratch. Used by the
// --clear-cache flag to recover from corrupt or outdated cached files.
func clearCache() {
	if err := os.RemoveAll(cacheDir()); err != nil {
		log.Printf("Model cache: cannot clear %s: %v", cacheDir(), err)
		return
	}
	if err := os.MkdirAll(cacheDir(), 0o755); err != nil {
		log.Printf("Model cache: cannot recreate %s: %v", cacheDir(), err)
		return
	}
	log.Printf("Model cache cleared: %s", cacheDir())
}

// warmModelCache downloads every missing file of every eager group — all the
// non-Japanese assets — one group per goroutine (models within a group
// sequentially, groups in parallel). The lazy groups (the Japanese models
// and the translation engine) are not touched here: they download on demand
// when the frontend requests them. Failures are logged and retried on the
// next start — or on demand, when the frontend asks for the file; serving
// continues with whatever is already cached.
func warmModelCache() {
	var wg sync.WaitGroup
	for _, group := range cacheGroups() {
		if !group.eager {
			continue
		}
		wg.Add(1)
		go func(dir, base string, files []string) {
			defer wg.Done()
			downloadGroup(filepath.Join(cacheDir(), dir), base, files)
		}(group.dir, group.base, group.files)
	}
	wg.Wait()
	log.Printf("Model cache ready: %s", cacheDir())
}

// downloadNew downloads url into full (the absolute path of cache-relative
// slash path rel) unless the file is cached by now. Callers hold fileLock(rel).
func downloadNew(rel, url, full string) error {
	if info, err := os.Stat(full); err == nil && !info.IsDir() && info.Size() > 0 {
		return nil // already cached (or completed by a concurrent caller)
	}
	// Subdirectories within a group (e.g. needle3/wasm/) may not exist yet.
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return downloadFile(url, full)
}

// fetchInto ensures the cache holds the file at cache-relative slash path
// rel, downloading it from url into full (its absolute path) when missing.
// The per-file lock lets concurrent callers — the startup warmer, on-demand
// requests and HEAD-probe kick-offs — share one download: whoever arrives
// second waits for the in-flight download instead of repeating it, then
// finds the file cached (see downloadNew).
func fetchInto(rel, url, full string) error {
	mu := fileLock(rel)
	mu.Lock()
	defer mu.Unlock()
	return downloadNew(rel, url, full)
}

// downloadGroup ensures every file of one group exists in dir, downloading
// the missing ones (a few retries each, as the downloads are hundreds of
// megabytes in total and transient network failures are worth absorbing).
func downloadGroup(dir, base string, files []string) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("Model cache: cannot create %s: %v", dir, err)
		return
	}
	for _, name := range files {
		dest := filepath.Join(dir, name)
		rel := relCachePath(dest)
		if info, err := os.Stat(dest); err == nil && !info.IsDir() && info.Size() > 0 {
			continue // already cached
		}
		url := base + "/" + name
		var err error
		for attempt := 1; attempt <= 3; attempt++ {
			if attempt > 1 {
				time.Sleep(time.Duration(attempt) * 2 * time.Second)
			}
			// fetchInto re-checks the cache under the per-file lock, so a
			// concurrent on-demand download of the same file (the frontend
			// racing the warmer on first launch) is joined, not repeated.
			err = fetchInto(rel, url, dest)
			if err == nil {
				break
			}
		}
		if err != nil {
			log.Printf("Model cache: %s: FAILED: %v", rel, err)
			continue
		}
	}
}

// downloadFile fetches url into dest atomically: the body is streamed to a
// temporary file in the destination directory and renamed into place, so an
// interrupted download never leaves a truncated file behind under the final
// name. When the server declares a Content-Length, the received byte count
// must match it.
func downloadFile(url, dest string) error {
	response, err := http.Get(url)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d for %s", response.StatusCode, url)
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".download-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// Report live progress while the body streams (see downloadProgress and
	// the /cache/status endpoint); removed on return, so the entry never
	// outlives the download.
	rel := relCachePath(dest)
	beginDownload(rel, response.ContentLength)
	defer endDownload(rel)
	written, copyErr := io.Copy(tmp, &progressReader{r: response.Body, rel: rel})
	closeErr := tmp.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	if copyErr == nil && response.ContentLength >= 0 && written != response.ContentLength {
		copyErr = fmt.Errorf("size mismatch: got %d, want %d", written, response.ContentLength)
	}
	if copyErr != nil {
		os.Remove(tmpName)
		return copyErr
	}
	if err := os.Rename(tmpName, dest); err != nil {
		os.Remove(tmpName)
		return err
	}
	log.Printf("Model cache: %s: %s", relCachePath(dest), humanSize(written))
	return nil
}

// downloadProgress is the live state of one in-flight download: bytes
// received so far and the total the server declared (0 when it did not).
type downloadProgress struct {
	received int64
	total    int64
}

// The downloads currently in flight, keyed by cache-relative path (guarded
// by downloadsMu). Entries exist only while a download runs — beginDownload
// adds, endDownload removes — so /cache/status reports "downloading" exactly
// when a byte stream is actually in progress, whether the download was
// started by the startup warmer or by an on-demand request.
var (
	downloadsMu     sync.Mutex
	downloadsActive = map[string]*downloadProgress{}
)

// beginDownload registers an in-flight download of rel.
func beginDownload(rel string, total int64) {
	downloadsMu.Lock()
	defer downloadsMu.Unlock()
	downloadsActive[rel] = &downloadProgress{total: total}
}

// endDownload forgets the in-flight entry for rel: afterwards the file is
// either cached (and reported as such) or absent again.
func endDownload(rel string) {
	downloadsMu.Lock()
	defer downloadsMu.Unlock()
	delete(downloadsActive, rel)
}

// downloadProgressAdd bumps the received count of an in-flight download.
func downloadProgressAdd(rel string, n int64) {
	downloadsMu.Lock()
	defer downloadsMu.Unlock()
	if state, ok := downloadsActive[rel]; ok {
		state.received += n
	}
}

// downloadProgressOf reports the live progress of rel, if it is downloading.
func downloadProgressOf(rel string) (received, total int64, ok bool) {
	downloadsMu.Lock()
	defer downloadsMu.Unlock()
	state, ok := downloadsActive[rel]
	if !ok {
		return 0, 0, false
	}
	return state.received, state.total, true
}

// progressReader counts the bytes streamed through it into the in-flight
// download entry of its file (see downloadProgressOf).
type progressReader struct {
	r   io.Reader
	rel string
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.r.Read(p)
	if n > 0 {
		downloadProgressAdd(pr.rel, int64(n))
	}
	return n, err
}

// relCachePath renders a cache path relative to the cache root, for logging.
func relCachePath(full string) string {
	rel, err := filepath.Rel(cacheDir(), full)
	if err != nil {
		return full
	}
	return filepath.ToSlash(rel)
}

// humanSize formats a byte count for the log.
func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f kB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// serveModelCache serves /models/…, /needle3/… and /translation/… from the
// cache directory, downloading on demand when a requested file is not yet
// cached (the Japanese models and the translation engine are lazy groups —
// see cacheGroups — and eager groups re-download here when a startup
// download failed). GETs answer only once the file is cached (they block on
// the download); HEADs — the frontend's model probes — answer 404 right
// away and kick the download off in the background instead, so probing
// never blocks and never downloads files under the table (see the HEAD
// branch below). It returns false for paths outside those prefixes.
// Requests inside the prefixes are always handled here — with a plain 404
// for anything that is not an approved group file — so the frontend's model
// probing never mistakes the SPA fallback (index.html) for a model file, and
// unapproved paths never trigger a download. A failed download answers 502
// so the frontend can report it instead of mistaking it for a missing file.
func serveModelCache(w http.ResponseWriter, r *http.Request) bool {
	rel, ok := cacheRelPath(r.URL.Path)
	if !ok {
		return false
	}
	if rel == "" {
		http.NotFound(w, r)
		return true
	}
	url, ok := groupFileURL(rel)
	if !ok {
		http.NotFound(w, r)
		return true
	}
	full := filepath.Join(cacheDir(), filepath.FromSlash(rel))
	if serveIfCached(w, r, full) {
		return true
	}
	// The model probe (see resolveModelUrls in frontend/src/main.ts) HEADs
	// the local paths to learn what the server has. A HEAD must neither block
	// on nor silently perform the download: answer 404 (the file is not there
	// yet) and kick the download off in the background, so the next probe
	// round — and the cache watcher's toast, which reports the download while
	// it runs — sees it appear. Answering the probe by downloading first made
	// the probe loop find every file "immediately": the frontend logged the
	// model as fully local while the backend log showed the same files being
	// fetched on demand, and every probed file was downloaded twice (the
	// warmer and the probe racing each other).
	if r.Method == http.MethodHead {
		if _, _, inFlight := downloadProgressOf(rel); !inFlight {
			go func() {
				if err := fetchInto(rel, url, full); err != nil {
					log.Printf("Model cache: %s: FAILED: %v", rel, err)
				}
			}()
		}
		http.NotFound(w, r)
		return true
	}
	// Not cached yet: download once, guarded by a per-file lock so
	// concurrent requests for the same file share one download.
	mu := fileLock(rel)
	mu.Lock()
	defer mu.Unlock()
	if serveIfCached(w, r, full) {
		return true // downloaded by a concurrent request while we waited
	}
	log.Printf("Model cache: %s: not cached — downloading on demand", rel)
	if err := downloadNew(rel, url, full); err != nil {
		log.Printf("Model cache: %s: FAILED: %v", rel, err)
		http.Error(w, "download failed", http.StatusBadGateway)
		return true
	}
	http.ServeFile(w, r, full)
	return true
}

// cacheRelPath maps a request path inside the served prefixes to a
// cache-relative slash path, below the subdirectory matching the prefix. The
// result is cleaned: it can never escape the cache root, and traversal
// segments collapse within the prefix's own subtree. An empty result with
// ok=true means a bare prefix request.
func cacheRelPath(urlPath string) (rel string, ok bool) {
	for _, prefix := range cachePrefixes {
		if urlPath != prefix.url && !strings.HasPrefix(urlPath, prefix.url+"/") {
			continue
		}
		var rest string
		if len(urlPath) > len(prefix.url) {
			rest = urlPath[len(prefix.url)+1:]
		}
		cleaned := path.Clean("/" + rest)
		if cleaned == "/" {
			return "", true
		}
		return prefix.dir + cleaned, true
	}
	return "", false
}
