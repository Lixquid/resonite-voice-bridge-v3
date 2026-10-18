package main

// Warm model cache: downloads the models that are too large to ship with the
// app into a per-user cache folder and serves them to the frontend over HTTP,
// so the frontend never has to reach an external service itself:
//
//   - The small and medium Moonshine streaming speech models, from the pinned
//     Moonshine CDN revision, served under /models/<name>/<file>.
//   - The Needle 3 engine (JS + WASM) and model blob, from the pinned
//     Hugging Face revision, served under /needle3/<file> — the same layout
//     the engine expects from its base URL.
//   - The browser-side translation engine (Transformers.js and one OPUS-MT
//     model per direction), from pinned revisions, served under
//     /translation/<file>. Unlike the groups above these download lazily,
//     when the frontend first requests them, because translation is off by
//     default (see serveTranslationFile).
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

// The pinned Moonshine CDN revision the small and medium models come from.
// Bump deliberately, mirroring frontend/scripts/fetch-models.mjs.
const moonshineCDNBase = "https://download.moonshine.ai/model"
const moonshineCDNRev = "quantized_26_07_30"

// The pinned Hugging Face revision of the Needle 3 engine. Must match the
// revision the frontend was built against (see frontend/src/needle.ts).
const needle3Base = "https://huggingface.co/Cactus-Compute/needle3/resolve/c7c415a3d1b3d929014bc6e866d51ebb971f7089"

// The pinned sources of the browser-side translation engine (the Translation
// Stream, see frontend/src/translate.ts): the Transformers.js library build,
// and one OPUS-MT model per direction. Must match the revisions the frontend
// was built against. Unlike the groups above, these are NOT downloaded at
// startup — translation is off by default, so every translation asset is
// fetched lazily the first time the frontend requests it (see
// serveTranslationFile). Vars rather than constants so tests can retarget
// them at a local server.
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

// modelFiles lists the canonical filenames every streaming Moonshine model
// needs (same list as MODEL_FILES in frontend/src/main.ts).
var modelFiles = []string{
	"frontend.ort",
	"encoder.ort",
	"adapter.ort",
	"cross_kv.ort",
	"decoder_kv.ort",
	"streaming_config.json",
	"tokenizer.bin",
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

// Cache-download groups: a cache-relative directory, the base URL its files
// are fetched from, and the files within it. The cache layout mirrors the
// served URL layout (models/… under /models/, needle3/… under /needle3/).
// The translation assets are deliberately absent: translation is off by
// default and must not download anything until the frontend asks for it.
func cacheGroups() []struct {
	dir   string
	base  string
	files []string
} {
	return []struct {
		dir   string
		base  string
		files []string
	}{
		{
			dir:   filepath.Join("models", "small_streaming"),
			base:  moonshineCDNBase + "/small-streaming-en/" + moonshineCDNRev,
			files: modelFiles,
		},
		{
			dir:   filepath.Join("models", "medium_streaming"),
			base:  moonshineCDNBase + "/medium-streaming-en/" + moonshineCDNRev,
			files: modelFiles,
		},
		{
			dir:   "needle3",
			base:  needle3Base,
			files: needle3Files,
		},
	}
}

// translationFileURL maps every approved translation asset (cache-relative
// slash path) to the pinned remote URL it comes from. Requests for anything
// else under /translation/ are refused: asset serving is restricted to the
// approved model files (see serveTranslationFile).
func translationFileURLs() map[string]string {
	urls := make(map[string]string, len(translationLibFiles)+2*len(translationModelFiles))
	for _, name := range translationLibFiles {
		urls["translation/lib/"+name] = transformersJSBase + "/" + name
	}
	for _, model := range []struct{ id, base string }{
		{"opus-tatoeba-en-ja", translationEnJapBase},
		{"opus-mt-ja-en", translationJaEnBase},
	} {
		for _, name := range translationModelFiles {
			urls["translation/models/"+model.id+"/"+name] = model.base + "/" + name
		}
	}
	return urls
}

// Per-file locks so concurrent requests for the same lazy asset download it
// once instead of racing (guarded by translationLocksMu).
var (
	translationLocksMu sync.Mutex
	translationLocks   = map[string]*sync.Mutex{}
)

// translationLock returns the download lock for one cache-relative path.
func translationLock(rel string) *sync.Mutex {
	translationLocksMu.Lock()
	defer translationLocksMu.Unlock()
	mu, ok := translationLocks[rel]
	if !ok {
		mu = &sync.Mutex{}
		translationLocks[rel] = mu
	}
	return mu
}

// serveTranslationFile serves one file of the translation engine from the
// cache, downloading it first when needed — translation assets are fetched
// lazily so an unused feature never costs bandwidth. Only approved files
// (see translationFileURLs) are ever served or downloaded; anything else 404s
// without touching the network. A failed download answers 502 so the frontend
// can report it instead of mistaking it for a missing file.
func serveTranslationFile(w http.ResponseWriter, r *http.Request, rel string) {
	url, ok := translationFileURLs()[rel]
	if !ok {
		http.NotFound(w, r)
		return
	}
	full := filepath.Join(cacheDir(), filepath.FromSlash(rel))
	if serveIfCached(w, r, full) {
		return
	}
	mu := translationLock(rel)
	mu.Lock()
	defer mu.Unlock()
	if serveIfCached(w, r, full) {
		return // downloaded by a concurrent request while we waited
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		log.Printf("Model cache: %s: cannot create directory: %v", rel, err)
		http.Error(w, "cache directory unavailable", http.StatusInternalServerError)
		return
	}
	log.Printf("Model cache: %s: not cached — downloading on demand", rel)
	if err := downloadFile(url, full); err != nil {
		log.Printf("Model cache: %s: FAILED: %v", rel, err)
		http.Error(w, "download failed", http.StatusBadGateway)
		return
	}
	http.ServeFile(w, r, full)
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

// warmModelCache downloads every missing cache file, one group per goroutine
// (models within a group sequentially, groups in parallel). Failures are
// logged and retried on the next start; serving continues with whatever is
// already cached.
func warmModelCache() {
	groups := cacheGroups()
	var wg sync.WaitGroup
	for _, group := range groups {
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
// cache directory, returning false for paths outside those prefixes. Requests
// inside the prefixes are always handled here — with a plain 404 for missing
// files — so the frontend's model probing never mistakes the SPA fallback
// (index.html) for a model file. Translation assets additionally download on
// demand (see serveTranslationFile).
func serveModelCache(w http.ResponseWriter, r *http.Request) bool {
	rel, ok := cacheRelPath(r.URL.Path)
	if !ok {
		return false
	}
	if rel == "" {
		http.NotFound(w, r)
		return true
	}
	if strings.HasPrefix(rel, "translation/") {
		serveTranslationFile(w, r, rel)
		return true
	}
	full := filepath.Join(cacheDir(), filepath.FromSlash(rel))
	if serveIfCached(w, r, full) {
		return true
	}
	http.NotFound(w, r)
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