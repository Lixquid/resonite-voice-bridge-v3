//go:build darwin

package main

import (
	"fmt"
	"os/exec"
	"strings"
)

// showErrorDialog shows a native macOS error alert via osascript and blocks
// until the user dismisses it.
//
// The message is escaped for the AppleScript string literal, so arbitrary
// error text cannot break out of the quoted script.
func showErrorDialog(title, message string) {
	escape := func(s string) string {
		s = strings.ReplaceAll(s, "\\", "\\\\")
		s = strings.ReplaceAll(s, "\"", "\\\"")
		return s
	}
	script := fmt.Sprintf("display dialog \"%s\" with title \"%s\" buttons {\"OK\"} default button \"OK\" with icon stop",
		escape(message), escape(title))
	// Best effort: if osascript itself fails (e.g. no display server), there
	// is nothing else to show; the log line written by
	// showErrorDialogAndExit still records the failure.
	_ = exec.Command("osascript", "-e", script).Run()
}
