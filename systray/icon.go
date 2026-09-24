//go:build !windows

package main

import _ "embed"

// icon is the tray icon (32x32 PNG) shown in the system tray.
//
// Windows needs an .ico instead (see icon_windows.go): its LoadImage API
// cannot load PNG files, so a PNG tray icon silently fails to appear.
//
//go:embed icon.png
var icon []byte
