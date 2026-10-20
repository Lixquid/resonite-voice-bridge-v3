package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
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
		// Every served file is revalidated against this server: the on-disk
		// cache folder is the single source of truth, so the browser must
		// never reuse a stale heuristically-cached copy across app updates
		// or after --clear-cache.
		if c.status == http.StatusOK {
			if got := recorder.Header().Get("Cache-Control"); got != "no-cache" {
				t.Errorf("serveModelCache(%q) Cache-Control = %q, want %q", c.urlPath, got, "no-cache")
			}
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

// TestCacheFileURL verifies the cache path to served URL mapping is the
// exact inverse of cacheRelPath for every served prefix.
func TestCacheFileURL(t *testing.T) {
	cases := []struct {
		rel string
		url string
	}{
		{"models/small_streaming/encoder.ort", "/models/small_streaming/encoder.ort"},
		{"models/tiny_streaming_ja/frontend.weights.ort", "/models/tiny_streaming_ja/frontend.weights.ort"},
		{"needle3/needle3.cact", "/needle3/needle3.cact"},
		{"needle3/wasm/needle.wasm", "/needle3/wasm/needle.wasm"},
		{"translation/lib/transformers.min.js", "/translation/lib/transformers.min.js"},
		{"translation/models/opus-mt-ja-en/onnx/encoder_model_quantized.onnx", "/translation/models/opus-mt-ja-en/onnx/encoder_model_quantized.onnx"},
		{"", ""},
		{"outside/file", ""},
	}
	for _, c := range cases {
		if got := cacheFileURL(c.rel); got != c.url {
			t.Errorf("cacheFileURL(%q) = %q, want %q", c.rel, got, c.url)
		}
	}
}

// TestCapabilityGroupsCoverAllCacheGroups verifies every cache group belongs
// to exactly one capability group, so no downloadable file is missing from
// the /cache/status report and none is reported twice.
func TestCapabilityGroupsCoverAllCacheGroups(t *testing.T) {
	owners := map[string]int{}
	for _, capability := range capabilityGroups() {
		for _, dir := range capability.dirs {
			owners[dir]++
		}
	}
	for _, group := range cacheGroups() {
		if owners[group.dir] != 1 {
			t.Errorf("cache group %q is referenced by %d capability groups, want exactly 1", group.dir, owners[group.dir])
		}
	}
	if len(owners) != len(cacheGroups()) {
		t.Errorf("capability groups reference %d cache groups, want %d", len(owners), len(cacheGroups()))
	}
}

// TestServeCacheStatus verifies the /cache/status endpoint: it answers GET
// requests with a JSON report of every individual file and every capability
// group, non-GET requests fall through to the regular handler, and the
// per-file cached/size fields mirror what is actually on disk.
func TestServeCacheStatus(t *testing.T) {
	dir := withTestCacheDir(t)

	// Two files cached, several groups incomplete or empty.
	cached := map[string]string{
		"models/small_streaming/tokenizer.bin": "tok",
		"translation/lib/transformers.min.js":  "lib",
	}
	for rel, content := range cached {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("MkdirAll: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}
	// A zero-size file must be reported as not cached, like the downloader.
	empty := filepath.Join(dir, "needle3", "needle3.cact")
	if err := os.MkdirAll(filepath.Dir(empty), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(empty, nil, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// Non-GET requests and other paths fall through (handled = false).
	recorder := httptest.NewRecorder()
	if serveCacheStatus(recorder, httptest.NewRequest("POST", cacheStatusPath, nil)) {
		t.Error("POST /cache/status was handled, want fall-through")
	}
	if serveCacheStatus(recorder, httptest.NewRequest("GET", "/cache/status/extra", nil)) {
		t.Error("GET /cache/status/extra was handled, want fall-through")
	}

	recorder = httptest.NewRecorder()
	if !serveCacheStatus(recorder, httptest.NewRequest("GET", cacheStatusPath, nil)) {
		t.Fatal("GET /cache/status was not handled")
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if ct := recorder.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var report cacheStatusReport
	if err := json.Unmarshal(recorder.Body.Bytes(), &report); err != nil {
		t.Fatalf("response is not valid JSON: %v\n%s", err, recorder.Body.String())
	}

	// The flat file list: one entry per distinct cached file, sorted by path.
	wantCached := map[string]int64{
		"models/small_streaming/tokenizer.bin": 3,
		"translation/lib/transformers.min.js":  3,
	}
	seen := map[string]bool{}
	for _, file := range report.Files {
		if seen[file.Path] {
			t.Errorf("file %q reported twice", file.Path)
		}
		seen[file.Path] = true
		if file.URL == "" {
			t.Errorf("file %q has no served URL", file.Path)
		}
		size, want := file.Size, wantCached[file.Path]
		if want != 0 && (file.Cached != (size == want)) {
			t.Errorf("file %q: cached = %v with size %d, want cached with size %d", file.Path, file.Cached, size, want)
		}
	}
	if len(report.Files) != len(seen) {
		t.Errorf("file list has %d entries, want %d", len(report.Files), len(seen))
	}
	for rel := range wantCached {
		if !seen[rel] {
			t.Errorf("cached file %q missing from the report", rel)
		}
	}
	if !seen["needle3/needle3.cact"] {
		t.Error("needle3/needle3.cact missing from the report")
	}
	for _, file := range report.Files {
		if file.Path == "needle3/needle3.cact" && (file.Cached || file.Size != 0) {
			t.Errorf("zero-size file %q: cached = %v, size = %d; want not cached", file.Path, file.Cached, file.Size)
		}
	}

	// The capability groups: the six named capabilities, with ready,
	// cachedFiles and totalFiles reflecting the cache contents.
	wantGroups := map[string]struct {
		cached int
		total  int
		ready  bool
	}{
		"shared":          {1, 3, false},
		"english-stt":     {1, 14, false},
		"japanese-stt":    {0, 16, false},
		"tool-calling":    {0, 3, false},
		"translate-en-ja": {0, 6, false},
		"translate-ja-en": {0, 6, false},
	}
	for _, group := range report.Groups {
		want, ok := wantGroups[group.ID]
		if !ok {
			t.Errorf("unexpected capability group %q", group.ID)
			continue
		}
		if group.TotalFiles != want.total || group.CachedFiles != want.cached || group.Ready != want.ready {
			t.Errorf("group %q: cachedFiles = %d, totalFiles = %d, ready = %v; want %d, %d, %v",
				group.ID, group.CachedFiles, group.TotalFiles, group.Ready, want.cached, want.total, want.ready)
		}
		if group.Ready != (group.CachedFiles == group.TotalFiles && group.TotalFiles > 0) {
			t.Errorf("group %q: ready = %v is inconsistent with %d/%d cached", group.ID, group.Ready, group.CachedFiles, group.TotalFiles)
		}
		if len(group.Files) != group.TotalFiles {
			t.Errorf("group %q lists %d files, totalFiles = %d", group.ID, len(group.Files), group.TotalFiles)
		}
		delete(wantGroups, group.ID)
	}
	if len(wantGroups) != 0 {
		for id := range wantGroups {
			t.Errorf("capability group %q missing from the report", id)
		}
	}

	// Once everything a capability needs is on disk, the group turns ready.
	// Seed the whole shared group (the smallest one) and re-check.
	for _, group := range cacheGroups() {
		if group.dir != "translation/lib" {
			continue
		}
		for _, name := range group.files {
			full := filepath.Join(dir, filepath.FromSlash(group.dir), filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				t.Fatalf("MkdirAll: %v", err)
			}
			if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}
		}
	}
	recorder = httptest.NewRecorder()
	if !serveCacheStatus(recorder, httptest.NewRequest("GET", cacheStatusPath, nil)) {
		t.Fatal("second GET /cache/status was not handled")
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &report); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	for _, group := range report.Groups {
		if group.ID != "shared" {
			continue
		}
		if !group.Ready || group.CachedFiles != group.TotalFiles {
			t.Errorf("shared group: ready = %v with %d/%d cached, want ready", group.Ready, group.CachedFiles, group.TotalFiles)
		}
	}
}

// TestDownloadProgress verifies the live download registry: while
// downloadFile streams a slow response, fileStatus reports the file as
// downloading with growing received bytes and the declared total; after the
// download finishes, the entry is gone and the file is cached.
func TestDownloadProgress(t *testing.T) {
	dir := withTestCacheDir(t)

	// A slow stream of a known size with a declared Content-Length.
	const payloadSize = 64
	gotFirstRead := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(payloadSize))
		for i := 0; i < payloadSize; i++ {
			if i == payloadSize/2 {
				close(gotFirstRead)
			}
			_, _ = w.Write([]byte("x"))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			time.Sleep(20 * time.Millisecond)
		}
	}))
	t.Cleanup(server.Close)

	dest := filepath.Join(dir, "needle3", "needle3.cact")
	// downloadFile writes only; downloadGroup owns directory creation.
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- downloadFile(server.URL, dest) }()

	// Wait until the download is midway, then inspect the live status.
	<-gotFirstRead
	status := fileStatus("needle3/needle3.cact")
	if !status.Downloading {
		t.Fatalf("midway status = %+v, want downloading", status)
	}
	if status.Received <= 0 || status.Received > payloadSize {
		t.Errorf("midway received = %d, want 0 < received <= %d", status.Received, payloadSize)
	}
	if status.Total != payloadSize {
		t.Errorf("midway total = %d, want %d (the declared Content-Length)", status.Total, payloadSize)
	}
	if status.Cached {
		t.Error("midway status reports cached, want false until the rename")
	}

	// The group aggregates the live progress.
	group := downloadGroupTestStatus("needle3")
	if group.DownloadingFiles != 1 {
		t.Errorf("group downloadingFiles = %d, want 1", group.DownloadingFiles)
	}
	if group.TotalBytes != payloadSize {
		t.Errorf("group totalBytes = %d, want %d", group.TotalBytes, payloadSize)
	}
	if group.ReceivedBytes <= 0 || group.ReceivedBytes > payloadSize {
		t.Errorf("group receivedBytes = %d, want 0 < received <= %d", group.ReceivedBytes, payloadSize)
	}

	// Once the download finishes, the entry is gone and the file is cached.
	if err := <-done; err != nil {
		t.Fatalf("downloadFile: %v", err)
	}
	if _, _, ok := downloadProgressOf("needle3/needle3.cact"); ok {
		t.Error("download entry still present after completion, want removed")
	}
	status = fileStatus("needle3/needle3.cact")
	if !status.Cached || status.Size != payloadSize {
		t.Errorf("final status = %+v, want cached with size %d", status, payloadSize)
	}
}

// downloadGroupTestStatus builds the capability group status for one cache
// group directory, mirroring the aggregation in serveCacheStatus.
func downloadGroupTestStatus(dir string) cacheGroupStatus {
	for _, capability := range capabilityGroups() {
		for _, d := range capability.dirs {
			if d != dir {
				continue
			}
			gs := cacheGroupStatus{ID: capability.id}
			for _, group := range cacheGroups() {
				if group.dir != dir {
					continue
				}
				for _, name := range group.files {
					st := fileStatus(dir + "/" + name)
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
			return gs
		}
	}
	return cacheGroupStatus{}
}

// TestProbeHeadKicksDownload verifies the model probe's HEAD requests are
// answered 404 right away for files that are not cached yet — without
// blocking on, and without being answered by, the download — while the
// download itself is kicked off in the background exactly once, so the next
// probe finds the file (the frontend's probe loop and the cache watcher's
// toast then report the model honestly instead of the probe silently
// downloading everything and logging it as already local).
func TestProbeHeadKicksDownload(t *testing.T) {
	dir := withTestCacheDir(t)

	var mu sync.Mutex
	downloads := map[string]int{}
	started := make(chan struct{}, 100)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		downloads[r.URL.Path]++
		mu.Unlock()
		started <- struct{}{}
		time.Sleep(2 * time.Second) // slow enough to outlast the HEAD round trip
		_, _ = w.Write([]byte("asset:" + r.URL.Path))
	}))
	t.Cleanup(upstream.Close)

	savedCDN, savedCDNRev := moonshineCDNBase, moonshineCDNRev
	moonshineCDNBase = upstream.URL + "/model"
	moonshineCDNRev = "test-en-rev"
	t.Cleanup(func() { moonshineCDNBase, moonshineCDNRev = savedCDN, savedCDNRev })

	head := func(urlPath string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("HEAD", urlPath, nil)
		if handled := serveModelCache(recorder, request); !handled {
			t.Fatalf("serveModelCache(%q) was not handled by the cache", urlPath)
		}
		return recorder
	}

	// The first HEAD is answered 404 at once — the slow download must not
	// delay (or answer) it.
	began := time.Now()
	if recorder := head("/models/small_streaming/encoder.ort"); recorder.Code != http.StatusNotFound {
		t.Errorf("first HEAD status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
	if elapsed := time.Since(began); elapsed > time.Second {
		t.Errorf("first HEAD took %v; it must not block on the download", elapsed)
	}

	// The HEAD kicked the download off in the background...
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the HEAD did not kick off a background download")
	}
	// ...exactly once, even when the probe keeps re-HEADing the file.
	for i := 0; i < 5; i++ {
		if recorder := head("/models/small_streaming/encoder.ort"); recorder.Code != http.StatusNotFound {
			t.Errorf("HEAD while downloading: status = %d, want %d", recorder.Code, http.StatusNotFound)
		}
		time.Sleep(200 * time.Millisecond)
	}
	// The download lands in the cache, and the next HEAD finds it (200).
	full := filepath.Join(dir, "models", "small_streaming", "encoder.ort")
	waitDeadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(full); err == nil {
			break
		}
		if time.Now().After(waitDeadline) {
			t.Fatal("the kicked download never landed in the cache")
		}
		time.Sleep(200 * time.Millisecond)
	}
	if recorder := head("/models/small_streaming/encoder.ort"); recorder.Code != http.StatusOK {
		t.Errorf("HEAD after the download: status = %d, want %d", recorder.Code, http.StatusOK)
	}
	mu.Lock()
	count := downloads["/model/small-streaming-en/test-en-rev/encoder.ort"]
	mu.Unlock()
	if count != 1 {
		t.Errorf("upstream downloads of encoder.ort = %d, want 1 (repeated HEADs must not re-download)", count)
	}
}

// TestWarmupAndOnDemandShareOneDownload verifies the startup warmer and an
// on-demand request that race for the same missing file download it once:
// whoever arrives second joins the in-flight download instead of repeating
// it (first-launch duplicate downloads also double-counted in the cache
// watcher's toast totals).
func TestWarmupAndOnDemandShareOneDownload(t *testing.T) {
	withTestCacheDir(t)

	var mu sync.Mutex
	downloads := map[string]int{}
	var gateOnce sync.Once
	gate := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		downloads[r.URL.Path]++
		mu.Unlock()
		gateOnce.Do(func() { close(gate) }) // signal that a download has begun
		time.Sleep(500 * time.Millisecond)
		_, _ = w.Write([]byte("asset:" + r.URL.Path))
	}))
	t.Cleanup(upstream.Close)

	savedCDN, savedCDNRev, savedCDNJa, savedNeedle := moonshineCDNBase, moonshineCDNRev, moonshineCDNJaRev, needle3Base
	moonshineCDNBase = upstream.URL + "/model"
	moonshineCDNRev = "test-en-rev"
	moonshineCDNJaRev = "test-ja-rev"
	needle3Base = upstream.URL + "/needle3"
	t.Cleanup(func() {
		moonshineCDNBase, moonshineCDNRev, moonshineCDNJaRev, needle3Base = savedCDN, savedCDNRev, savedCDNJa, savedNeedle
	})

	// Start the warm-up and, as soon as its first download is in flight,
	// request the same file on demand.
	done := make(chan struct{})
	go func() {
		warmModelCache()
		close(done)
	}()
	select {
	case <-gate:
	case <-time.After(5 * time.Second):
		t.Fatal("the warm-up never started downloading")
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/models/small_streaming/encoder.ort", nil)
	if handled := serveModelCache(recorder, request); !handled {
		t.Fatal("serveModelCache was not handled by the cache")
	}
	if recorder.Code != http.StatusOK {
		t.Errorf("on-demand request status = %d, want %d", recorder.Code, http.StatusOK)
	}
	<-done // the warm-up finishes (everything cached, nothing re-downloaded)

	mu.Lock()
	count := downloads["/model/small-streaming-en/test-en-rev/encoder.ort"]
	mu.Unlock()
	if count != 1 {
		t.Errorf("upstream downloads of encoder.ort = %d, want 1 (the warmer and the on-demand request must share one download)", count)
	}
}
