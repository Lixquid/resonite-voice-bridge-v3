package main

import (
	"runtime/debug"
	"strings"
)

// version holds the embedded application version. It is set at build time
// with -ldflags "-X main.version=..." (see the Makefile) and is empty for
// plain `go build`/`go test` runs, in which case a fallback derived from the
// embedded VCS information is used.
var version string

// appVersion returns the application version for the running binary:
//
//   - the value injected at build time, when present: the tag naming the
//     current commit (e.g. "v1.2.3"), or the short commit ID otherwise,
//     with "-dirty" appended if there were uncommitted changes when the
//     binary was built;
//   - otherwise, the short commit ID recorded by the Go toolchain's VCS
//     stamping (with "-dirty" if the build had modifications), or "dev"
//     when no VCS information is available.
func appVersion() string {
	if version != "" {
		return version
	}

	rev := ""
	dirty := false
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, kv := range info.Settings {
			switch kv.Key {
			case "vcs.revision":
				rev = kv.Value
			case "vcs.modified":
				dirty = kv.Value == "true"
			}
		}
	}
	if rev == "" {
		return "dev"
	}
	if len(rev) > 7 {
		rev = rev[:7]
	}
	if dirty {
		rev += "-dirty"
	}
	return strings.TrimSpace(rev)
}
