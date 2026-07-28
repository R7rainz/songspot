package ws

import (
	"encoding/json"
	"log"
	"time"

	"songspot/internal/models"
	"songspot/internal/store"

	"github.com/redis/go-redis/v9"
)

type Hub struct {
	RoomID string

	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	quit       chan struct{}

	rooms  *store.RedisStore
	pubSub *redis.PubSub

	// refs counts attached clients. Guarded by the owning Registry's mutex, not
	// by the hub goroutine, so joins and teardown can be serialised.
	refs int
}

func newHub(roomID string, rooms *store.RedisStore) *Hub {
	return &Hub{
		RoomID:     roomID,
		clients:    make(map[*Client]bool),
		broadcast:  make(chan []byte),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		quit:       make(chan struct{}),
		rooms:      rooms,
	}
}

// run is the hub's event loop. Everything that touches h.clients happens here,
// on this one goroutine, so the map needs no lock of its own.
func (h *Hub) run() {
	h.startRedisSubscription()
	defer h.pubSub.Close()

	for {
		select {
		case <-h.quit:
			// The registry has already unhooked us; drop anyone still attached
			// so their write pumps close the sockets.
			for client := range h.clients {
				h.drop(client)
			}
			return

		case client := <-h.register:
			h.clients[client] = true
			h.broadcastPresence()

		case client := <-h.unregister:
			if h.clients[client] {
				h.drop(client)
				h.broadcastPresence()
			}

		case message := <-h.broadcast:
			for client := range h.clients {
				h.deliver(client, message)
			}
		}
	}
}

// drop detaches a client and signals its pumps to stop. Note it closes Done,
// never Send: Send is written to from each client's own read pump.
func (h *Hub) drop(client *Client) {
	delete(h.clients, client)
	select {
	case <-client.Done:
	default:
		close(client.Done)
	}
}

// deliver queues a message without ever blocking the hub. A client whose buffer
// is full is too slow or already gone, and gets dropped.
func (h *Hub) deliver(client *Client, message []byte) {
	select {
	case client.Send <- message:
	default:
		h.drop(client)
	}
}

// broadcastPresence tells everyone how many people are currently connected.
// Counting live sockets, deduped by user, is the truth about who's listening.
func (h *Hub) broadcastPresence() {
	users := make(map[string]struct{}, len(h.clients))
	for client := range h.clients {
		users[client.UserID] = struct{}{}
	}

	msg, err := json.Marshal(models.WSEvent{
		Action:    "presence",
		Data:      map[string]any{"count": len(users)},
		Timestamp: time.Now().UnixMilli(),
	})
	if err != nil {
		log.Printf("failed to encode presence event: %v", err)
		return
	}

	for client := range h.clients {
		select {
		case client.Send <- msg:
		default:
		}
	}
}
