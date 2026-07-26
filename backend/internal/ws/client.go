package ws

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"songspot/internal/models"

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

		var event models.WSEvent
		if err := json.Unmarshal(message, &event); err != nil {
			continue
		}

		ctx := context.Background()
		channelName := "room_events:" + c.hub.RoomID

		switch event.Action {
		case "ping":
			// Answered straight back to this client only; it is how the
			// frontend estimates its clock offset from the server.
			dataMap, ok := event.Data.(map[string]any)
			if !ok {
				continue
			}
			clientTime, ok := dataMap["clientTime"].(float64)
			if !ok {
				continue
			}
			pong, err := json.Marshal(models.WSEvent{
				Action: "pong",
				Data: models.TimeSyncData{
					ClientTime: int64(clientTime),
					ServerTime: time.Now().UnixMilli(),
				},
				Timestamp: time.Now().UnixMilli(),
			})
			if err == nil {
				c.send(pong)
			}

		case "play", "pause", "seek":
			dataMap, ok := event.Data.(map[string]any)
			if !ok {
				log.Println("Invalid data payload for sync event")
				continue
			}

			syncTimeMs, ok := dataMap["syncTimeMs"].(float64)
			if !ok {
				log.Println("syncTimeMs missing from sync event")
				continue
			}

			roomKey := "room:" + c.hub.RoomID
			roomDataStr, err := c.hub.redisClient.Get(ctx, roomKey).Result()
			if err != nil {
				log.Printf("Failed to fetch room state: %v", err)
				continue
			}

			var room models.RoomData
			if err := json.Unmarshal([]byte(roomDataStr), &room); err != nil {
				log.Printf("Failed to decode room state: %v", err)
				continue
			}

			// Host-only playback: drop control events from non-hosts unless the
			// host has handed control to everyone.
			if !room.State.EveryoneControls && c.UserID != room.State.HostID {
				continue
			}

			room.State.IsPlaying = event.Action == "play"
			room.State.SyncTimeMs = int64(syncTimeMs)
			room.State.UpdatedAt = time.Now().UnixMilli()

			updatedRoomData, err := json.Marshal(room)
			if err != nil {
				log.Printf("Failed to encode room state: %v", err)
				continue
			}

			if err := c.hub.redisClient.Set(ctx, roomKey, updatedRoomData, models.RoomTTL).Err(); err != nil {
				log.Printf("Failed to update room state: %v", err)
				continue
			}

			// Stamp with server time so receivers can work out how much of the
			// song has elapsed since the event was published.
			event.Timestamp = time.Now().UnixMilli()
			enrichedMsg, err := json.Marshal(event)
			if err != nil {
				log.Printf("Failed to encode sync event: %v", err)
				continue
			}

			if err := c.hub.redisClient.Publish(ctx, channelName, string(enrichedMsg)).Err(); err != nil {
				log.Printf("Failed to publish sync event to Redis: %v", err)
			}

		default:
			if err := c.hub.redisClient.Publish(ctx, channelName, string(message)).Err(); err != nil {
				log.Printf("Failed to publish to Redis: %v", err)
			}
		}
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
