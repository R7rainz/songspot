package ws

import (
	"context"
	"encoding/json"
	"log"
	"songspot/internal/models"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

// middleman between the websocket connection and the hub
type Client struct {
	Hub    *Hub
	UserID string
	Conn   *websocket.Conn
	Send   chan []byte
}

// readpump pumps messages from the websocket connection to the hub this runs in a dedicated goroutine for each client
func (c *Client) ReadPump() {
	defer func() {
		c.Hub.Unregister <- c
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
		if err = json.Unmarshal(message, &event); err == nil && event.Action == "ping" {
			dataMap, ok := event.Data.(map[string]interface{})
			if ok {
				clientTimeValue, ok := dataMap["clientTime"].(float64)
				if !ok {
					continue
				}

				pongData := models.TimeSyncData{
					ClientTime: int64(clientTimeValue),
					ServerTime: time.Now().UnixMilli(),
				}

				pongEvent := models.WSEvent{
					Action:    "pong",
					Data:      pongData,
					Timestamp: time.Now().UnixMilli(),
				}

				if responseMsg, err := json.Marshal(pongEvent); err == nil {
					c.Send <- responseMsg // bound directly back to this client
				}
			}
			continue
		}

		ctx := context.Background()
		channelName := "room_events:" + c.Hub.RoomID

		switch event.Action {
		case "play", "pause", "seek":
			dataMap, ok := event.Data.(map[string]interface{})
			if !ok {
				log.Println("Invalid data payload for sync event")
				continue
			}

			syncTimeMs, ok := dataMap["syncTimeMs"].(float64)
			if !ok {
				log.Println("syncTimeMs missing from sync event")
				continue
			}

			roomKey := "room:" + c.Hub.RoomID
			roomDataStr, err := c.Hub.redisClient.Get(ctx, roomKey).Result()
			if err != nil {
				log.Printf("Failed to fetch room state: %v", err)
				continue
			}

			var room models.RoomData
			if err := json.Unmarshal([]byte(roomDataStr), &room); err != nil {
				log.Printf("Failed to decode room state: %v", err)
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

			if err := c.Hub.redisClient.Set(ctx, roomKey, updatedRoomData, 0).Err(); err != nil {
				log.Printf("Failed to update room state: %v", err)
				continue
			}

			event.Timestamp = time.Now().UnixMilli()
			enrichedMsg, err := json.Marshal(event)
			if err != nil {
				log.Printf("Failed to encode sync event: %v", err)
				continue
			}

			if err := c.Hub.redisClient.Publish(ctx, channelName, string(enrichedMsg)).Err(); err != nil {
				log.Printf("Failed to publish sync event to Redis: %v", err)
			}

		default:
			err = c.Hub.redisClient.Publish(ctx, channelName, string(message)).Err()
			if err != nil {
				log.Printf("Failed to publish to Redis: %v", err)
			}
		}
	}
}

// writepump pumps messages from the hub to the websocket connection
// also runs in a dedicated goroutine for each client
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

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
