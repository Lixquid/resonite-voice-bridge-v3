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

// URL prefixes the cache is served under (see serveModelCache and
// cacheRelPath). Each prefix maps onto the cache subdirectory of the same
// name, so the served layout mirrors the cache layout (and, for /needle3/,
// the layout the Needle 3 worker expects from its base URL).
const modelsURLPrefix = "/models"
const needleURLPrefix = "/needle3"

// cachePrefixes pairs each served URL prefix with its cache directory.
var cachePrefixes = []struct{ url, dir string }{
	{modelsURLPrefix, "models"},
	{needleURLPrefix, "needle3"},
}

// Cache-download groups: a cache-relative directory, the base URL its files
// are fetched from, and the files within it. The cache layout mirrors the
// served URL layout (models/… under /models/, needle3/… under /needle3/).
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

// serveModelCache serves /models/… and /needle3/… from the cache directory,
// returning false for paths outside those prefixes. Requests inside the
// prefixes are always handled here — with a plain 404 for missing files — so
// the frontend's model probing never mistakes the SPA fallback (index.html)
// for a model file.
func serveModelCache(w http.ResponseWriter, r *http.Request) bool {
	rel, ok := cacheRelPath(r.URL.Path)
	if !ok {
		return false
	}
	if rel == "" {
		http.NotFound(w, r)
		return true
	}
	full := filepath.Join(cacheDir(), filepath.FromSlash(rel))
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
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