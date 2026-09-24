//go:build windows

package main

import _ "embed"

// icon is the tray icon shown in the system tray on Windows.
//
// Windows' LoadImage API (used by fyne.io/systray with LR_LOADFROMFILE)
// only supports .ico files; a PNG would be silently rejected and the tray
// icon would never appear. icon.ico embeds the artwork from misc/icon.png
// at multiple sizes (16x16 through 256x256) so Windows can pick the best
// match for the tray and for hi-DPI displays.
//
//go:embed icon.ico
var icon []byte
