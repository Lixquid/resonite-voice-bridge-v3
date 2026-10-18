package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// TestServeTranslationLazyDownload verifies translation assets are fetched
// lazily: an approved file that is not yet cached is downloaded from the
// pinned source on the first request and served from the cache afterwards,
// while paths that are not approved assets are refused without any download.
func TestServeTranslationLazyDownload(t *testing.T) {
	dir := withTestCacheDir(t)

	var downloads int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloads++
		_, _ = w.Write([]byte("asset:" + r.URL.Path))
	}))
	t.Cleanup(server.Close)

	// Retarget the pinned sources at the test server for the duration.
	savedLib, savedEn, savedJa := transformersJSBase, translationEnJapBase, translationJaEnBase
	transformersJSBase = server.URL + "@huggingface/transformers@" + transformersJSVersion + "/dist"
	translationEnJapBase = server.URL + "/Kadonox/opus-tatoeba-en-ja-onnx/resolve/" + translationEnJapRev
	translationJaEnBase = server.URL + "/Xenova/opus-mt-ja-en/resolve/" + translationJaEnRev
	t.Cleanup(func() { transformersJSBase, translationEnJapBase, translationJaEnBase = savedLib, savedEn, savedJa })

	get := func(urlPath string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("GET", urlPath, nil)
		if handled := serveModelCache(recorder, request); !handled {
			t.Fatalf("serveModelCache(%q) was not handled by the cache", urlPath)
		}
		return recorder
	}

	// An approved asset downloads on demand and is served with its contents.
	recorder := get("/translation/models/opus-tatoeba-en-ja/config.json")
	if recorder.Code != http.StatusOK {
		t.Fatalf("first request status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if body := recorder.Body.String(); body != "asset:/Kadonox/opus-tatoeba-en-ja-onnx/resolve/"+translationEnJapRev+"/config.json" {
		t.Errorf("first request body = %q", body)
	}
	// The second request is served from the cache: no second download.
	if recorder := get("/translation/models/opus-tatoeba-en-ja/config.json"); recorder.Code != http.StatusOK {
		t.Errorf("second request status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if downloads != 1 {
		t.Errorf("downloads = %d, want 1 (the second request must be served from the cache)", downloads)
	}
	if _, err := os.Stat(filepath.Join(dir, "translation", "models", "opus-tatoeba-en-ja", "config.json")); err != nil {
		t.Errorf("asset not stored in the cache layout: %v", err)
	}

	// A path that is not an approved asset: 404, and no download attempt.
	recorder = get("/translation/models/opus-tatoeba-en-ja/vocab.json")
	if recorder.Code != http.StatusNotFound {
		t.Errorf("non-approved asset status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
	if recorder = get("/translation/models/opus-mt-ja-en/../../../secret.txt"); recorder.Code != http.StatusNotFound {
		t.Errorf("traversal under /translation/ status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
	if downloads != 1 {
		t.Errorf("downloads = %d, want 1 (non-approved paths must not trigger downloads)", downloads)
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

	cases := []struct {
		urlPath string
		handled bool
		status  int
		body    string
	}{
		{"/models/small_streaming/tokenizer.bin", true, http.StatusOK, "tok"},
		{"/models/small_streaming/missing.ort", true, http.StatusNotFound, ""},
		{"/needle3/needle3.cact", true, http.StatusNotFound, ""},
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