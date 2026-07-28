package ws

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"songspot/internal/models"
)

func (c *Client) handleIncomingMessage(message []byte) {
	var event models.WSEvent
	if err := json.Unmarshal(message, &event); err != nil {
		return
	}

	switch event.Action {
	case "ping":
		c.handlePing(event)
	case "play", "pause", "seek":
		c.handlePlaybackEvent(event)
	default:
		c.publishRaw(message)
	}
}

func (c *Client) handlePing(event models.WSEvent) {
	// Answered straight back to this client only; it is how the frontend
	// estimates its clock offset from the server.
	dataMap, ok := event.Data.(map[string]any)
	if !ok {
		return
	}
	clientTime, ok := dataMap["clientTime"].(float64)
	if !ok {
		return
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
}

func (c *Client) handlePlaybackEvent(event models.WSEvent) {
	dataMap, ok := event.Data.(map[string]any)
	if !ok {
		log.Println("Invalid data payload for sync event")
		return
	}

	syncTimeMs, ok := dataMap["syncTimeMs"].(float64)
	if !ok {
		log.Println("syncTimeMs missing from sync event")
		return
	}

	ctx := context.Background()
	room, err := c.hub.rooms.GetRoom(ctx, c.hub.RoomID)
	if err != nil {
		log.Printf("Failed to fetch room state: %v", err)
		return
	}

	// Host-only playback: drop control events from non-hosts unless the host
	// has handed control to everyone.
	if !room.State.EveryoneControls && c.UserID != room.State.HostID {
		return
	}

	// A seek keeps whatever play state the room was already in.
	if event.Action != "seek" {
		room.State.IsPlaying = event.Action == "play"
	}
	room.State.SyncTimeMs = int64(syncTimeMs)
	room.State.UpdatedAt = time.Now().UnixMilli()

	if err := c.hub.rooms.SaveRoom(ctx, c.hub.RoomID, room); err != nil {
		log.Printf("Failed to update room state: %v", err)
		return
	}

	// Stamp with server time so receivers can work out how much of the song has
	// elapsed since the event was published.
	event.Timestamp = time.Now().UnixMilli()
	payload, err := json.Marshal(event)
	if err != nil {
		log.Printf("Failed to encode sync event: %v", err)
		return
	}

	if err := c.hub.rooms.PublishRoomEvent(ctx, c.hub.RoomID, payload); err != nil {
		log.Printf("Failed to publish sync event to Redis: %v", err)
	}
}

func (c *Client) publishRaw(message []byte) {
	if err := c.hub.rooms.PublishRoomEvent(context.Background(), c.hub.RoomID, message); err != nil {
		log.Printf("Failed to publish to Redis: %v", err)
	}
}
