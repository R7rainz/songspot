package ws

import (
	"context"
	"log"

	"github.com/redis/go-redis/v9"
)

type Hub struct {
	RoomID      string
	Clients     map[*Client]bool
	Broadcast   chan []byte
	Register    chan *Client
	Unregister  chan *Client
	redisClient *redis.Client
	pubSub      *redis.PubSub
}

func NewHub(roomID string, rdb *redis.Client) *Hub {
	return &Hub{
		RoomID:      roomID,
		Broadcast:   make(chan []byte),
		Register:    make(chan *Client),
		Unregister:  make(chan *Client),
		Clients:     make(map[*Client]bool),
		redisClient: rdb,
	}
}

// starts the hub's event loop
// should be called as goroutine: go hub.Run()
func (h *Hub) Run() {
	ctx := context.Background()
	channelName := "room_events:" + h.RoomID
	h.pubSub = h.redisClient.Subscribe(ctx, channelName)

	go h.listenToRedis()
	defer func() {
		h.pubSub.Close()
	}()
	for {
		select {
		case client := <-h.Register:
			h.Clients[client] = true

		case client := <-h.Unregister:
			if _, ok := h.Clients[client]; ok {
				delete(h.Clients, client)
				close(client.Send)
			}

		case message := <-h.Broadcast:
			for client := range h.Clients {
				select {
				case client.Send <- message:
					// message queued successfully
				default:
					// if the client's send channel buffer is full, they are
					// dead or too slow. Drop them to save memory
					close(client.Send)
					delete(h.Clients, client)
				}
			}
		}
	}
}

func (h *Hub) listenToRedis() {
	ch := h.pubSub.Channel()

	for msg := range ch {
		h.Broadcast <- []byte(msg.Payload)
	}
	log.Printf("Redis Pub/Sub channel closed for room %s", h.RoomID)
}
