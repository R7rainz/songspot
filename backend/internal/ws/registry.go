package ws

import (
	"sync"

	"songspot/internal/store"
)

// Registry owns the per-room hubs. Hubs are created on the first join and torn
// down on the last leave: each one holds a goroutine and a Redis subscription,
// so keeping them around for every room the process has ever seen would leak.
//
// refs is maintained under mu, which makes "hand out a hub" and "shut a hub
// down" mutually exclusive.
type Registry struct {
	mu    sync.Mutex
	hubs  map[string]*Hub
	rooms *store.RedisStore
}

func NewRegistry(rooms *store.RedisStore) *Registry {
	return &Registry{hubs: make(map[string]*Hub), rooms: rooms}
}

// Join attaches a client to its room's hub, starting the hub if it is the
// room's first listener.
func (reg *Registry) Join(roomID string, client *Client) {
	reg.mu.Lock()
	hub, ok := reg.hubs[roomID]
	if !ok {
		hub = newHub(roomID, reg.rooms)
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
