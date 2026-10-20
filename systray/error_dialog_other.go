//go:build !windows && !darwin

package main

import (
	"log"
	"os/exec"
)

// dialogHelper describes one external program able to show a graphical
// error dialog, and how to turn a (title, message) pair into its command
// line. The message text is always passed as a command-line argument, so no
// quoting of the error text is needed.
type dialogHelper struct {
	name string // human-readable name used in log messages
	look string // executable name passed to exec.LookPath
	args func(title, message string) []string
}

// dialogHelpers lists the known dialog helpers in order of preference:
// zenity on GTK desktops, kdialog on KDE, and xmessage as the barebones X11
// fallback that ships with more minimal installations.
var dialogHelpers = []dialogHelper{
	{"zenity", "zenity", func(title, message string) []string {
		return []string{"--error", "--title", title, "--text", message, "--no-markup"}
	}},
	{"kdialog", "kdialog", func(title, message string) []string {
		return []string{"--error", message, "--title", title}
	}},
	{"xmessage", "xmessage", func(title, message string) []string {
		return []string{"-title", title, "-default", "OK", "-center", message}
	}},
}

// showErrorDialog shows an error dialog on Linux and the other Unix-like
// platforms, using the first helper from dialogHelpers that is installed.
//
// Unlike the Windows and macOS implementations there is no dialog that is
// guaranteed to exist, so every step is logged: which helper was picked and
// whether showing it failed. Without a display server (or with none of the
// helpers installed) nothing graphical can be shown at all; the log line
// written by showErrorDialogAndExit still records the failure.
func showErrorDialog(title, message string) {
	for _, helper := range dialogHelpers {
		if _, err := exec.LookPath(helper.look); err != nil {
			continue
		}
		log.Printf("Showing error dialog with %s", helper.name)
		if err := exec.Command(helper.look, helper.args(title, message)...).Run(); err != nil {
			// The helper exists but did not exit cleanly: either the user
			// dismissed the dialog abnormally or it could not show one at
			// all (e.g. a broken display server). Trying the next helper
			// would risk a second, duplicate dialog on a normal dismissal,
			// so only record the outcome and stop here.
			log.Printf("Showing the dialog with %s failed: %v", helper.name, err)
		}
		return
	}
	log.Printf("No dialog helper (zenity, kdialog or xmessage) is installed; the error is only recorded in this log")
}