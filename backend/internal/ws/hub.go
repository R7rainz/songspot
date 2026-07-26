package ws

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"songspot/internal/models"

	"github.com/redis/go-redis/v9"
)

// Registry owns the per-room hubs. Hubs are created on the first join and torn
// down on the last leave: each one holds a goroutine and a Redis subscription,
// so keeping them around for every room the process has ever seen would leak
// both for the lifetime of the server.
//
// refs is the reason this type exists rather than a bare map. It is maintained
// under mu, which makes "hand out a hub" and "shut a hub down" mutually
// exclusive — otherwise a joiner could take a hub pointer moments before the
// hub decided it was empty, then block forever registering with a dead loop.
type Registry struct {
	mu   sync.Mutex
	hubs map[string]*Hub
	rdb  *redis.Client
}

func NewRegistry(rdb *redis.Client) *Registry {
	return &Registry{hubs: make(map[string]*Hub), rdb: rdb}
}

// Join attaches a client to its room's hub, starting the hub if it is the
// room's first listener.
func (reg *Registry) Join(roomID string, client *Client) {
	reg.mu.Lock()
	hub, ok := reg.hubs[roomID]
	if !ok {
		hub = newHub(roomID, reg.rdb)
		reg.hubs[roomID] = hub
		go hub.run()
	}
	hub.refs++
	reg.mu.Unlock()

	client.hub = hub
	client.reg = reg
	hub.register <- client
}

// Leave detaches a client and stops the hub once nobody is left in the room.
// Every Join must be paired with exactly one Leave.
func (reg *Registry) Leave(client *Client) {
	hub := client.hub
	if hub == nil {
		return
	}
	hub.unregister <- client

	reg.mu.Lock()
	defer reg.mu.Unlock()
	hub.refs--
	if hub.refs > 0 {
		return
	}
	if reg.hubs[hub.RoomID] == hub {
		delete(reg.hubs, hub.RoomID)
	}
	close(hub.quit)
}

type Hub struct {
	RoomID string

	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	quit       chan struct{}

	redisClient *redis.Client
	pubSub      *redis.PubSub

	// refs counts attached clients. Guarded by the owning Registry's mutex,
	// not by the hub goroutine, so joins and teardown can be serialised.
	refs int
}

func newHub(roomID string, rdb *redis.Client) *Hub {
	return &Hub{
		RoomID:      roomID,
		clients:     make(map[*Client]bool),
		broadcast:   make(chan []byte),
		register:    make(chan *Client),
		unregister:  make(chan *Client),
		quit:        make(chan struct{}),
		redisClient: rdb,
	}
}

// run is the hub's event loop. Everything that touches h.clients happens here,
// on this one goroutine, so the map needs no lock of its own.
func (h *Hub) run() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h.pubSub = h.redisClient.Subscribe(ctx, "room_events:"+h.RoomID)
	defer h.pubSub.Close()

	go h.listenToRedis()

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
// never Send: Send is written to from each client's own read pump (pongs go
// straight back to the sender), so closing it here would be a data race that
// panics the server with "send on closed channel".
func (h *Hub) drop(client *Client) {
	delete(h.clients, client)
	select {
	case <-client.Done: // already dropped
	default:
		close(client.Done)
	}
}

// deliver queues a message without ever blocking the hub. A client whose buffer
// is full is too slow (or already gone) and gets dropped rather than allowed to
// stall the whole room.
func (h *Hub) deliver(client *Client, message []byte) {
	select {
	case client.Send <- message:
	default:
		h.drop(client)
	}
}

// broadcastPresence tells everyone how many people are currently connected.
// Counting live sockets — deduped by user, so one person's two tabs count once
// — is the truth about who's listening; the room's Users list is a roster that
// only grows, so it can't answer this.
//
// This counts clients on this server instance, which is accurate for a
// single-instance deployment. Scaling out would need the count to go through
// Redis as well.
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
		default: // buffer full — skip, they'll get the next update
		}
	}
}

func (h *Hub) listenToRedis() {
	ch := h.pubSub.Channel()
	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return
			}
			// Both sends select on quit so a hub that shuts down mid-message
			// doesn't strand this goroutine on an unbuffered channel.
			select {
			case h.broadcast <- []byte(msg.Payload):
			case <-h.quit:
				return
			}
		case <-h.quit:
			return
		}
	}
}
