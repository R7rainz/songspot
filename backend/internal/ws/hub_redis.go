package ws

import "context"

func (h *Hub) startRedisSubscription() {
	ctx, cancel := context.WithCancel(context.Background())
	h.pubSub = h.rooms.SubscribeRoomEvents(ctx, h.RoomID)

	go func() {
		<-h.quit
		cancel()
	}()
	go h.listenToRedis()
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
