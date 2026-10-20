//go:build !windows && !darwin

package main

import (
	"os/exec"
)

// showErrorDialog shows an error dialog on Linux and the other Unix-like
// platforms, using whichever helper is available: zenity on GTK desktops,
// kdialog on KDE. The message text is passed as a command-line argument, so
// no quoting of the error text is needed.
//
// If neither helper is installed (or executing one fails), there is nothing
// to show; the log line written by showErrorDialogAndExit still records the
// failure.
func showErrorDialog(title, message string) {
	// zenity takes the text and a --title option; --error selects the error
	// icon and presentation.
	if _, err := exec.LookPath("zenity"); err == nil {
		_ = exec.Command("zenity", "--error", "--title", title, "--text", message, "--no-markup").Run()
		return
	}
	if _, err := exec.LookPath("kdialog"); err == nil {
		_ = exec.Command("kdialog", "--error", message, "--title", title).Run()
		return
	}
}
