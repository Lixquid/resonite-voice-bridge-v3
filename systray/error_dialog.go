package main

import (
	"log"
	"os"
)

// showErrorDialogAndExit shows a native error dialog (see the
// platform-specific showErrorDialog implementations) and terminates the
// process.
//
// It is used for fatal startup failures such as the listen port already
// being in use: as a tray application the program has no visible console,
// and on Windows it is even linked with -H=windowsgui (see Makefile), so
// plain log output would go nowhere and the app would appear to "silently
// exit". The log line is still written first, so the message also ends up
// in the session log file when logging is available.
func showErrorDialogAndExit(title, message string) {
	log.Printf("Fatal: %s: %s", title, message)
	showErrorDialog(title, message)
	os.Exit(1)
}
