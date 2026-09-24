package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func startTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(newHandler())
	t.Cleanup(server.Close)
	return server
}

func dial(t *testing.T, server *httptest.Server) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func expectMessage(t *testing.T, conn *websocket.Conn) string {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	return string(data)
}

// TestRelayBroadcastToOthers verifies that a text frame sent by one client is
// retransmitted to every other connected client, but not back to the sender.
func TestRelayBroadcastToOthers(t *testing.T) {
	server := startTestServer(t)

	a := dial(t, server)
	b := dial(t, server)
	c := dial(t, server)

	// Let all handshakes settle server-side.
	time.Sleep(100 * time.Millisecond)

	if err := a.WriteMessage(websocket.TextMessage, []byte("hello")); err != nil {
		t.Fatalf("WriteMessage: %v", err)
	}

	if got := expectMessage(t, b); got != "hello" {
		t.Errorf("client B got %q, want %q", got, "hello")
	}
	if got := expectMessage(t, c); got != "hello" {
		t.Errorf("client C got %q, want %q", got, "hello")
	}

	// The sender must not receive its own message back.
	_ = a.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if _, _, err := a.ReadMessage(); err == nil {
		t.Error("client A received its own message back")
	}
}

// TestRelayDropsBinaryFrames verifies that binary frames are not relayed.
func TestRelayDropsBinaryFrames(t *testing.T) {
	server := startTestServer(t)

	a := dial(t, server)
	b := dial(t, server)
	time.Sleep(100 * time.Millisecond)

	if err := a.WriteMessage(websocket.BinaryMessage, []byte{0, 1, 2}); err != nil {
		t.Fatalf("WriteMessage: %v", err)
	}
	_ = b.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if _, _, err := b.ReadMessage(); err == nil {
		t.Error("binary frame was relayed")
	}
}

// TestFrontendServing verifies that plain HTTP requests serve the embedded
// frontend with the cross-origin isolation headers set.
func TestFrontendServing(t *testing.T) {
	server := startTestServer(t)

	resp, err := http.Get(server.URL + "/")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /: status %d, want 200", resp.StatusCode)
	}
	if resp.Header.Get("Cross-Origin-Opener-Policy") != "same-origin" {
		t.Error("missing Cross-Origin-Opener-Policy header")
	}
	if resp.Header.Get("Cross-Origin-Embedder-Policy") != "require-corp" {
		t.Error("missing Cross-Origin-Embedder-Policy header")
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if !strings.Contains(string(body), "<!doctype html>") && !strings.Contains(string(body), "<!DOCTYPE html>") {
		t.Errorf("GET / did not serve index.html: %.200s", body)
	}
}

// TestMoonshineModuleMimeType verifies that the vendored Moonshine binding is
// served with a JavaScript MIME type. Browsers refuse to execute ES modules
// with any other type, which would silently break the model load. On Windows
// the system registry can override the builtin .mjs type with "text/plain"
// (see mimeOverrides in server.go), so the header must be pinned explicitly.
func TestMoonshineModuleMimeType(t *testing.T) {
	server := startTestServer(t)

	resp, err := http.Get(server.URL + "/wasm/dist/moonshine.mjs")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("GET /wasm/dist/moonshine.mjs: status %d, want 200", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "javascript") {
		t.Errorf("GET /wasm/dist/moonshine.mjs: Content-Type %q, want a JavaScript MIME type", ct)
	}
}
