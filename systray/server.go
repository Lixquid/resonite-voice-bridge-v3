package main

import (
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path"
	"runtime"
	"strings"

	"github.com/lixquid/resonite-voice-bridge-v3/frontend"
)

// newHandler builds the HTTP handler serving both the frontend and the
// WebSocket relay on the same port.
//
// Any request carrying a WebSocket upgrade (regardless of the path, the
// canonical endpoint being the root "/") is routed to the relay. All other
// requests are served the embedded frontend.
var frontendFS = frontend.FS()

func newHandler() http.Handler {
	static := withCrossOriginHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.ServeFileFS(w, r, frontendFS, "index.html")
			return
		}
		if existsInFS(frontendFS, r.URL.Path[1:]) {
			serveStaticFile(w, r, r.URL.Path[1:])
			return
		}
		// The frontend is a single-page app: fall back to index.html for
		// paths that do not match a real file so deep links keep working.
		http.ServeFileFS(w, r, frontendFS, "index.html")
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			serveRelay(w, r)
			return
		}
		static.ServeHTTP(w, r)
	})
}

func existsInFS(root fs.FS, name string) bool {
	f, err := root.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	stat, err := f.Stat()
	return err == nil && !stat.IsDir()
}

// mimeOverrides forces correct content types for extensions whose type the
// platform's MIME database gets wrong. On Windows, mime.TypeByExtension (used
// by http.ServeFileFS) prefers the types registered in the system registry
// over Go's builtin table, and .mjs is commonly registered there as
// "text/plain". Browsers refuse to execute ES modules served with a
// non-JavaScript MIME type, so the vendored Moonshine binding (moonshine.mjs)
// would fail to load and no model could be fetched at all.
var mimeOverrides = map[string]string{
	".mjs": "text/javascript; charset=utf-8",
}

// serveStaticFile serves an embedded file, pinning the content type for any
// extension in mimeOverrides. Setting the header explicitly makes
// http.ServeFileFS keep it instead of sniffing (its own value is only applied
// when the header is absent).
func serveStaticFile(w http.ResponseWriter, r *http.Request, name string) {
	ext := strings.ToLower(path.Ext(name))
	if ct, ok := mimeOverrides[ext]; ok {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeFileFS(w, r, frontendFS, name)
}

// withCrossOriginHeaders adds the headers required for the frontend's
// threaded WASM build to access SharedArrayBuffer. They must be present on
// every response, including the vendored WASM and model files, so they are
// applied to the whole static file server (same approach as the Vite dev
// server config).
func withCrossOriginHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		next.ServeHTTP(w, r)
	})
}

// openBrowser opens the given URL in the default browser of the current OS.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		os.Stderr.WriteString("Failed to open browser: " + err.Error() + "\n")
	}
}
