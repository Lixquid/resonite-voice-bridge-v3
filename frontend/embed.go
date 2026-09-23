// Package frontend embeds the built frontend, so it can be packaged inside
// the final binary. Run `make frontend` (which builds the frontend with Vite)
// before `go build`, or use the top-level `make build` target which does both.
//
// The embedded filesystem is rooted at frontend/dist.
package frontend

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distFS embed.FS

// FS returns the built frontend as a filesystem rooted at dist.
func FS() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		// Cannot happen: dist is embedded above.
		panic(err)
	}
	return sub
}
