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

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
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
func serveCacheFile(w http.ResponseWriter, r *http.Request, full string) {
	ext := strings.ToLower(filepath.Ext(full))
	if ct, ok := mimeOverrides[ext]; ok {
		w.Header().Set("Content-Type", ct)
	} else if ext == ".wasm" {
		w.Header().Set("Content-Type", "application/wasm")
	}
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
		// Subdirectories within a group (e.g. needle3/wasm/) may not exist yet.
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			log.Printf("Model cache: %s: cannot create directory: %v", relCachePath(dest), err)
			continue
		}
		if info, err := os.Stat(dest); err == nil && info.Size() > 0 {
			continue // already cached
		}
		url := base + "/" + name
		var err error
		for attempt := 1; attempt <= 3; attempt++ {
			if attempt > 1 {
				time.Sleep(time.Duration(attempt) * 2 * time.Second)
			}
			err = downloadFile(url, dest)
			if err == nil {
				break
			}
		}
		if err != nil {
			log.Printf("Model cache: %s: FAILED: %v", relCachePath(dest), err)
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
	written, copyErr := io.Copy(tmp, response.Body)
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
// download failed). It returns false for paths outside those prefixes.
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
	// Not cached yet: download once, guarded by a per-file lock so
	// concurrent requests for the same file share one download.
	mu := fileLock(rel)
	mu.Lock()
	defer mu.Unlock()
	if serveIfCached(w, r, full) {
		return true // downloaded by a concurrent request while we waited
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		log.Printf("Model cache: %s: cannot create directory: %v", rel, err)
		http.Error(w, "cache directory unavailable", http.StatusInternalServerError)
		return true
	}
	log.Printf("Model cache: %s: not cached — downloading on demand", rel)
	if err := downloadFile(url, full); err != nil {
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
