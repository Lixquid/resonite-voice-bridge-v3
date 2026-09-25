// Command systray is the Graphical Relay program for Resonite Voice Bridge.
//
// It lives inside the system tray and serves, on the single port 6789:
//
//   - The built frontend (see frontend/) over plain HTTP.
//   - A WebSocket relay on the root path: any text frame received from one
//     connected client is retransmitted to every other connected client.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"time"

	"fyne.io/systray"
)

// The one and only port this application exposes.
const listenPort = "6789"

func main() {
	showVersion := flag.Bool("version", false, "print the embedded version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(appVersion())
		return
	}

	log.Printf("Resonite Voice Bridge %s", appVersion())

	ln, err := net.Listen("tcp", ":"+listenPort)
	if err != nil {
		log.Fatalf("Failed to listen on port %s: %v", listenPort, err)
	}

	server := &http.Server{Handler: newHandler()}
	go func() {
		log.Printf("Serving on http://localhost:%s", listenPort)
		if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP server failed: %v", err)
		}
	}()

	systray.Run(onReady, onExit)
}

func onReady() {
	systray.SetIcon(icon)
	systray.SetTitle("Voice Bridge")
	systray.SetTooltip("Resonite Voice Bridge " + appVersion() + " — http://localhost:" + listenPort)

	// Readonly entry at the top of the menu showing the embedded
	// application version (see version.go).
	mVersion := systray.AddMenuItem("Version: "+appVersion(), "Embedded application version")
	mVersion.Disable()

	// Toggleable entry controlling whether the web interface is opened in
	// the browser on every start. The choice is persisted in the user's
	// configuration directory (see settings.go) so it survives restarts.
	cfg := loadSettings(mustSettingsPath())
	mAutoStart := systray.AddMenuItemCheckbox("Auto-start Web Interface",
		"Open http://localhost:"+listenPort+" in your browser at startup",
		cfg.AutoStart)
	if cfg.AutoStart {
		// The HTTP server is already listening at this point (see main), so
		// opening the browser immediately is safe.
		openBrowser("http://localhost:" + listenPort)
	}

	mOpen := systray.AddMenuItem("Open Web Interface", "Open http://localhost:"+listenPort+" in your browser")

	// Informational entry showing how many clients are currently connected
	// to the relay. It is disabled and refreshed once a second.
	mClients := systray.AddMenuItem("", "Clients currently connected to the relay")
	mClients.Disable()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			mClients.SetTitle(fmt.Sprintf("Connected clients: %d", theRelay.count()))
			<-ticker.C
		}
	}()

	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Shut down the relay")

	go func() {
		for {
			select {
			case <-mAutoStart.ClickedCh:
				// Checkbox menu item: the systray library does not flip the
				// check mark itself (on any platform), so the new state must be
				// computed from the old one *before* the menu is updated, and
				// that one value is used for both the UI and the saved setting.
				// Saving in a goroutine that re-reads Checked() would race with
				// Check/Uncheck below and could persist the inverse state.
				autoStart := !mAutoStart.Checked()
				if autoStart {
					mAutoStart.Check()
				} else {
					mAutoStart.Uncheck()
				}
				if err := saveSettings(mustSettingsPath(), settings{AutoStart: autoStart}); err != nil {
					log.Printf("Saving settings: %v", err)
				}
			case <-mOpen.ClickedCh:
				openBrowser("http://localhost:" + listenPort)
			case <-mQuit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}

func onExit() {
	// Nothing to clean up: the process is exiting anyway.
}

// mustSettingsPath returns the settings file location, terminating the
// process only if the operating system cannot provide a configuration
// directory at all. Without one, no persistent preferences are possible.
func mustSettingsPath() string {
	path, err := settingsPath()
	if err != nil {
		log.Fatalf("Cannot determine settings location: %v", err)
	}
	return path
}
