package main

import (
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Connection liveness timings.
const (
	writeWait  = 10 * time.Second
	pingPeriod = 50 * time.Second
	pongWait   = 60 * time.Second
)

// client is one connected WebSocket peer. Frames are never written directly
// from a reader goroutine: instead they are queued on send and drained by a
// single writer goroutine, keeping concurrent writes safe.
type client struct {
	conn *websocket.Conn
	send chan string
}

// relay retransmits text frames from every connected client to every other
// connected client.
type relay struct {
	mu      sync.Mutex
	clients map[*client]struct{}
}

var theRelay = &relay{clients: make(map[*client]struct{})}

var upgrader = websocket.Upgrader{
	// The relay is a public broadcast endpoint; accept any origin.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// count returns the number of currently connected clients.
func (r *relay) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.clients)
}

// serveRelay upgrades the request and starts pumping frames for this client.
func serveRelay(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrader already replied with an HTTP error.
		return
	}
	c := &client{conn: conn, send: make(chan string, 16)}

	theRelay.mu.Lock()
	theRelay.clients[c] = struct{}{}
	theRelay.mu.Unlock()

	defer func() {
		theRelay.mu.Lock()
		delete(theRelay.clients, c)
		theRelay.mu.Unlock()
		close(c.send)
		conn.Close()
	}()

	// One writer goroutine per connection for the lifetime of the client.
	go c.writePump()
	c.readPump()
}

// readPump receives frames from the client and retransmits text frames to
// every other connected client. It returns as soon as the connection dies,
// which unblocks the deferred cleanup in serveRelay.
func (c *client) readPump() {
	defer c.conn.Close()
	c.conn.SetReadLimit(1 << 20)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		messageType, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.TextMessage {
			// Only text frames are relayed; binary frames are dropped.
			continue
		}
		broadcast(c, string(data))
	}
}

// writePump drains the client's send channel into the socket, interleaving
// ping frames to keep the connection alive.
func (c *client) writePump() {
	tick := time.NewTicker(pingPeriod)
	defer tick.Stop()
	for {
		select {
		case message, ok := <-c.send:
			if !ok {
				// Channel closed: the client is being cleaned up.
				_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				_ = c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, []byte(message)); err != nil {
				return
			}
		case <-tick.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// broadcast sends a text message to every connected client except the sender.
func broadcast(sender *client, message string) {
	theRelay.mu.Lock()
	targets := make([]*client, 0, len(theRelay.clients))
	for c := range theRelay.clients {
		if c != sender {
			targets = append(targets, c)
		}
	}
	theRelay.mu.Unlock()

	for _, c := range targets {
		select {
		case c.send <- message:
		default:
			// Client's buffer is full; drop the message for it rather than
			// blocking everyone else.
			log.Printf("relay: send buffer full for a client; dropping message")
		}
	}
}
