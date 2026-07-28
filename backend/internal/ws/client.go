package ws

import (
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

// Client is the middleman between one websocket connection and its room's hub.
type Client struct {
	UserID string
	Conn   *websocket.Conn
	Send   chan []byte
	// Done is closed by the hub when this client is detached. It replaces
	// closing Send, which the client's own read pump also writes to.
	Done chan struct{}

	hub *Hub
	reg *Registry
}

func NewClient(userID string, conn *websocket.Conn) *Client {
	return &Client{
		UserID: userID,
		Conn:   conn,
		Send:   make(chan []byte, 256),
		Done:   make(chan struct{}),
	}
}

// send queues a message for this client, giving up if the client has already
// been detached rather than blocking forever on a buffer nobody is draining.
func (c *Client) send(message []byte) {
	select {
	case c.Send <- message:
	case <-c.Done:
	}
}

// ReadPump pumps messages from the websocket connection to the hub. Runs in a
// dedicated goroutine per client.
func (c *Client) ReadPump() {
	defer func() {
		c.reg.Leave(c)
		c.Conn.Close()
	}()

	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error:%v", err)
			}
			break
		}

		c.handleIncomingMessage(message)
	}
}

// WritePump pumps messages from the hub to the websocket connection. Also runs
// in a dedicated goroutine per client.
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case <-c.Done:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
			return

		case message := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			w, err := c.Conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)
			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
