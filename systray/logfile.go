package main

import (
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// theLogFilePath holds the location of the log file after setupLogFile has
// run. It is empty when logging to a file is unavailable (e.g. the operating
// system could not provide a configuration directory), in which case the
// menu entry to open the log is disabled.
var theLogFilePath string

// logFilePath returns the location of the log file:
// <UserConfigDir>/resonite-voice-bridge/log.txt (e.g.
// ~/.config/resonite-voice-bridge/log.txt on Linux,
// %APPDATA%\resonite-voice-bridge\log.txt on Windows). It lives next to the
// settings file (see settings.go) so everything the app persists is in one
// folder.
func logFilePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "resonite-voice-bridge", "log.txt"), nil
}

// setupLogFile truncates the log file — wiping whatever the previous run
// wrote, so every session starts with an empty log — and directs all output
// of the standard logger into it. The standard error output is kept via an
// io.MultiWriter so console builds (and stderr redirections, e.g. under a
// service manager) still see the messages; on Windows GUI builds the stderr
// write is simply discarded by the operating system.
//
// The returned file handle stays open for the lifetime of the process; this
// program has no other shutdown path than exiting, so the handle is never
// closed explicitly.
func setupLogFile() (string, error) {
	path, err := logFilePath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	// O_TRUNC implements the wipe-on-startup behaviour: the file is emptied
	// before the first message of this run is written.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", err
	}
	log.SetOutput(io.MultiWriter(f, os.Stderr))
	theLogFilePath = path
	return path, nil
}

// openFile opens the given file with the operating system's default
// handler (usually the associated text editor for a .txt file), mirroring
// how openBrowser works for URLs.
func openFile(path string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// rundll32's FileProtocolHandler accepts file paths as well as URLs
		// and opens them with the default associated application.
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("Failed to open %s: %v", path, err)
	}
}