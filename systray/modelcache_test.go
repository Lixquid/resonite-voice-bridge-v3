package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// withTestCacheDir points the model cache at a fresh temporary directory for
// the duration of one test.
func withTestCacheDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	setCacheDirForTest(dir)
	t.Cleanup(func() { setCacheDirForTest("") })
	return dir
}

// TestCacheRelPath verifies the request-path to cache-path mapping: the
// served prefixes map into the cache, bare prefixes map to empty, and
// traversal attempts cannot escape the cache root.
func TestCacheRelPath(t *testing.T) {
	cases := []struct {
		urlPath string
		rel     string
		ok      bool
	}{
		{"/models/small_streaming/tokenizer.bin", "models/small_streaming/tokenizer.bin", true},
		{"/models/medium_streaming/encoder.ort", "models/medium_streaming/encoder.ort", true},
		{"/needle3/needle3.cact", "needle3/needle3.cact", true},
		{"/needle3/wasm/needle.js", "needle3/wasm/needle.js", true},
		{"/translation/lib/transformers.min.js", "translation/lib/transformers.min.js", true},
		{"/translation/models/opus-tatoeba-en-ja/config.json", "translation/models/opus-tatoeba-en-ja/config.json", true},
		{"/translation/models/opus-mt-ja-en/onnx/encoder_model_quantized.onnx", "translation/models/opus-mt-ja-en/onnx/encoder_model_quantized.onnx", true},
		{"/translation", "", true},
		{"/translation/", "", true},
		{"/models", "", true},
		{"/models/", "", true},
		{"/needle3", "", true},
		{"/needle3/", "", true},
		{"/", "", false},
		{"/index.html", "", false},
		{"/modelsx/file", "", false},
		{"/models2/file", "", false},
		// Traversal attempts are cleaned away within the prefix's own
		// subtree: nothing escapes the cache root (or the prefix directory).
		{"/models/../../etc/passwd", "models/etc/passwd", true},
		{"/models/../settings.json", "models/settings.json", true},
		{"/needle3/../../x", "needle3/x", true},
	}
	for _, c := range cases {
		rel, ok := cacheRelPath(c.urlPath)
		if ok != c.ok || rel != c.rel {
			t.Errorf("cacheRelPath(%q) = (%q, %v), want (%q, %v)", c.urlPath, rel, ok, c.rel, c.ok)
		}
	}
}

// TestCacheGroupsFileSets verifies every cache group's file set and download
// policy: the Moonshine groups are the shared file set plus the language's
// own export files (a mismatch here makes the frontend's probes for files
// like frontend.model.ort 404 forever — see modelFileSet in
// frontend/src/main.ts), and only the non-Japanese groups are eager
// (pre-downloaded on start); the Japanese and translation groups download on
// demand (see cacheGroups in modelcache.go).
func TestCacheGroupsFileSets(t *testing.T) {
	for _, group := range cacheGroups() {
		wantEager := !strings.HasSuffix(group.dir, "_ja") && !strings.HasPrefix(group.dir, "translation")
		if group.eager != wantEager {
			t.Errorf("group %q: eager = %v, want %v (only the non-Japanese, non-translation groups pre-download on start)",
				group.dir, group.eager, wantEager)
		}
		if !strings.HasPrefix(group.dir, "models") {
			continue // not a speech model (needle3, translation)
		}
		want := append(append([]string{}, modelFilesShared...), modelFilesJa...)
		if !strings.HasSuffix(group.dir, "_ja") {
			want = modelFilesEn
		}
		if len(group.files) != len(want) {
			t.Errorf("group %q has %d files, want %d", group.dir, len(group.files), len(want))
			continue
		}
		for i, name := range want {
			if group.files[i] != name {
				t.Errorf("group %q file[%d] = %q, want %q", group.dir, i, group.files[i], name)
			}
		}
	}
}

// TestServeLazyDownload verifies lazy asset downloads work the same for
// every lazy group — the Japanese Moonshine models and the translation
// engine: an approved file that is not yet cached is downloaded from the
// pinned source on the first request and served from the cache afterwards,
// while paths that are not approved assets are refused without any download.
func TestServeLazyDownload(t *testing.T) {
	dir := withTestCacheDir(t)

	var downloads int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloads++
		_, _ = w.Write([]byte("asset:" + r.URL.Path))
	}))
	t.Cleanup(server.Close)

	// Retarget the pinned sources at the test server for the duration.
	savedCDN, savedCDNJa := moonshineCDNBase, moonshineCDNJaRev
	moonshineCDNBase = server.URL + "/model"
	moonshineCDNJaRev = "test-ja-rev"
	savedLib, savedEn, savedJa := transformersJSBase, translationEnJapBase, translationJaEnBase
	transformersJSBase = server.URL + "@huggingface/transformers@" + transformersJSVersion + "/dist"
	translationEnJapBase = server.URL + "/Kadonox/opus-tatoeba-en-ja-onnx/resolve/" + translationEnJapRev
	translationJaEnBase = server.URL + "/Xenova/opus-mt-ja-en/resolve/" + translationJaEnRev
	t.Cleanup(func() {
		moonshineCDNBase, moonshineCDNJaRev = savedCDN, savedCDNJa
		transformersJSBase, translationEnJapBase, translationJaEnBase = savedLib, savedEn, savedJa
	})

	get := func(urlPath string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("GET", urlPath, nil)
		if handled := serveModelCache(recorder, request); !handled {
			t.Fatalf("serveModelCache(%q) was not handled by the cache", urlPath)
		}
		return recorder
	}

	// A Japanese model file downloads on demand and is served with its
	// contents: the frontend requests it, the backend fetches and caches it.
	recorder := get("/models/small_streaming_ja/frontend.model.ort")
	if recorder.Code != http.StatusOK {
		t.Fatalf("first request status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if body := recorder.Body.String(); body != "asset:/model/small-streaming-ja/test-ja-rev/frontend.model.ort" {
		t.Errorf("first request body = %q", body)
	}
	// The second request is served from the cache: no second download.
	if recorder := get("/models/small_streaming_ja/frontend.model.ort"); recorder.Code != http.StatusOK {
		t.Errorf("second request status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if downloads != 1 {
		t.Errorf("downloads = %d, want 1 (the second request must be served from the cache)", downloads)
	}
	if _, err := os.Stat(filepath.Join(dir, "models", "small_streaming_ja", "frontend.model.ort")); err != nil {
		t.Errorf("asset not stored in the cache layout: %v", err)
	}

	// A translation asset downloads on demand the same way.
	recorder = get("/translation/models/opus-tatoeba-en-ja/config.json")
	if recorder.Code != http.StatusOK {
		t.Fatalf("translation request status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if body := recorder.Body.String(); body != "asset:/Kadonox/opus-tatoeba-en-ja-onnx/resolve/"+translationEnJapRev+"/config.json" {
		t.Errorf("translation request body = %q", body)
	}

	// A path that is not an approved asset: 404, and no download attempt.
	recorder = get("/models/small_streaming_ja/vocab.bin")
	if recorder.Code != http.StatusNotFound {
		t.Errorf("non-approved asset status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
	recorder = get("/translation/models/opus-tatoeba-en-ja/vocab.json")
	if recorder.Code != http.StatusNotFound {
		t.Errorf("non-approved translation asset status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
	if recorder = get("/translation/models/opus-mt-ja-en/../../../secret.txt"); recorder.Code != http.StatusNotFound {
		t.Errorf("traversal under /translation/ status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
	if downloads != 2 {
		t.Errorf("downloads = %d, want 2 (non-approved paths must not trigger downloads)", downloads)
	}
}

// TestServeModelCache verifies cached files are served with their contents,
// missing files inside the prefixes answer 404 (not the SPA fallback), and
// cleaned paths cannot read files outside the cache directory.
func TestServeModelCache(t *testing.T) {
	dir := withTestCacheDir(t)

	cached := filepath.Join(dir, "models", "small_streaming")
	if err := os.MkdirAll(cached, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(cached, "tokenizer.bin"), []byte("tok"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	// A secret outside the cache root that traversal must not expose.
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// needle3.cact is an approved group file: write it into the cache so it
	// can be served without a real download.
	needleBlob := filepath.Join(dir, "needle3", "needle3.cact")
	if err := os.MkdirAll(filepath.Dir(needleBlob), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(needleBlob, []byte("cact"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	cases := []struct {
		urlPath string
		handled bool
		status  int
		body    string
	}{
		{"/models/small_streaming/tokenizer.bin", true, http.StatusOK, "tok"},
		{"/needle3/needle3.cact", true, http.StatusOK, "cact"},
		// Not an approved group file: 404 without any download attempt.
		{"/models/small_streaming/missing.ort", true, http.StatusNotFound, ""},
		{"/models", true, http.StatusNotFound, ""},
		// path.Clean collapses the traversal inside the prefix's subtree; the
		// requested secret stays unreadable.
		{"/models/../../secret.txt", true, http.StatusNotFound, ""},
		// Outside the prefixes: not handled by the cache at all.
		{"/whatever", false, 0, ""},
	}
	for _, c := range cases {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("GET", c.urlPath, nil)
		handled := serveModelCache(recorder, request)
		if handled != c.handled {
			t.Errorf("serveModelCache(%q) handled = %v, want %v", c.urlPath, handled, c.handled)
			continue
		}
		if !c.handled {
			continue
		}
		if recorder.Code != c.status {
			t.Errorf("serveModelCache(%q) status = %d, want %d", c.urlPath, recorder.Code, c.status)
			continue
		}
		if c.body != "" && recorder.Body.String() != c.body {
			t.Errorf("serveModelCache(%q) body = %q, want %q", c.urlPath, recorder.Body.String(), c.body)
		}
	}
}

// (Path-traversal behavior is covered by TestCacheRelPath and the traversal
// cases of TestServeModelCache: cacheRelPath collapses ".." segments within
// the prefix's own subtree, so nothing outside the cache root is reachable.)

// TestWarmModelCacheNonJapanese verifies the startup warm-up downloads only
// the eager groups — all the non-Japanese assets: the English Moonshine
// models and Needle 3. The Japanese models and the translation engine must
// not be touched: they download on demand when the frontend requests them.
func TestWarmModelCacheNonJapanese(t *testing.T) {
	dir := withTestCacheDir(t)

	var mu sync.Mutex
	requested := map[string]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requested[r.URL.Path] = true
		mu.Unlock()
		_, _ = w.Write([]byte("asset:" + r.URL.Path))
	}))
	t.Cleanup(server.Close)

	// Retarget the pinned sources at the test server for the duration.
	savedCDN, savedCDNRev, savedCDNJa, savedNeedle := moonshineCDNBase, moonshineCDNRev, moonshineCDNJaRev, needle3Base
	moonshineCDNBase = server.URL + "/model"
	moonshineCDNRev = "test-en-rev"
	moonshineCDNJaRev = "test-ja-rev"
	needle3Base = server.URL + "/needle3"
	t.Cleanup(func() {
		moonshineCDNBase, moonshineCDNRev, moonshineCDNJaRev, needle3Base = savedCDN, savedCDNRev, savedCDNJa, savedNeedle
	})

	warmModelCache()

	// Every eager group file is in the cache...
	for _, group := range cacheGroups() {
		if !group.eager {
			continue
		}
		for _, name := range group.files {
			full := filepath.Join(dir, filepath.FromSlash(group.dir), filepath.FromSlash(name))
			if _, err := os.Stat(full); err != nil {
				t.Errorf("eager group %q: %s not cached after warm-up: %v", group.dir, name, err)
			}
		}
	}
	// ...while the lazy groups were never requested at all.
	for path := range requested {
		if strings.Contains(path, "-ja/") {
			t.Errorf("startup downloaded a Japanese model file: %s", path)
		}
	}
	for _, lazy := range []string{"models/small_streaming_ja", "models/tiny_streaming_ja", "translation"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(lazy))); !os.IsNotExist(err) {
			t.Errorf("lazy group %q exists after warm-up; startup must not touch it", lazy)
		}
	}
}

// TestDownloadFile verifies downloads land under the final name with the
// exact declared Content-Length, and that a mismatch (truncated body) fails
// without modifying the destination or leaving temporary files behind.
func TestDownloadFile(t *testing.T) {
	dir := withTestCacheDir(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/good":
			w.Header().Set("Content-Length", "5")
			_, _ = w.Write([]byte("hello"))
		case "/truncated":
			w.Header().Set("Content-Length", "5")
			_, _ = w.Write([]byte("hi"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	dest := filepath.Join(dir, "models", "small_streaming", "tokenizer.bin")
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	if err := downloadFile(server.URL+"/good", dest); err != nil {
		t.Fatalf("downloadFile(good): %v", err)
	}
	data, err := os.ReadFile(dest)
	if err != nil || string(data) != "hello" {
		t.Fatalf("destination content = %q, err = %v; want \"hello\"", data, err)
	}
	if leftovers := tempFiles(dir); len(leftovers) != 0 {
		t.Errorf("temporary files left behind: %v", leftovers)
	}

	if err := downloadFile(server.URL+"/truncated", dest); err == nil {
		t.Error("downloadFile(truncated): expected a size-mismatch error")
	}
	if data, _ := os.ReadFile(dest); string(data) != "hello" {
		t.Errorf("destination was modified by the failed download: %q", data)
	}
	if leftovers := tempFiles(dir); len(leftovers) != 0 {
		t.Errorf("temporary files left behind by the failed download: %v", leftovers)
	}

	if err := downloadFile(server.URL+"/missing", dest); err == nil {
		t.Error("downloadFile(missing): expected an HTTP 404 error")
	}
}

// tempFiles lists leftover .download-* temporary files under dir.
func tempFiles(dir string) []string {
	matches, _ := filepath.Glob(filepath.Join(dir, ".download-*"))
	return matches
}
