// Command systray is the Graphical Relay program for Resonite Voice Bridge.
//
// It lives inside the system tray and serves, on the single port 6789:
//
//   - The built frontend (see frontend/) over plain HTTP.
//   - A WebSocket relay on the root path: any text frame received from one
//     connected client is retransmitted to every other connected client.
package main

import (
	"log"
	"net"
	"net/http"

	"fyne.io/systray"
)

// The one and only port this application exposes.
const listenPort = "6789"

func main() {
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
	systray.SetTooltip("Resonite Voice Bridge — http://localhost:" + listenPort)

	mOpen := systray.AddMenuItem("Open Web Interface", "Open http://localhost:"+listenPort+" in your browser")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Shut down the relay")

	go func() {
		for {
			select {
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
