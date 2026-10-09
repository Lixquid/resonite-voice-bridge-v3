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