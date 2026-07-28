package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"songspot/internal/models"
	"songspot/internal/music"
	"songspot/internal/store"
	"songspot/internal/ws"
)

type Server struct {
	ctx           context.Context
	rooms         *store.RedisStore
	registry      *ws.Registry
	musicProvider *music.InnerTube
}

func SetupRestRoutes(mux *http.ServeMux, rooms *store.RedisStore) {
	server := &Server{
		ctx:           context.Background(),
		rooms:         rooms,
		registry:      ws.NewRegistry(rooms),
		musicProvider: music.NewInnerTube(),
	}
	server.registerRoutes(mux)
}

func (s *Server) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /ws", s.handleWebSocket)

	mux.HandleFunc("POST /rooms", s.handleCreateRoom)
	mux.HandleFunc("GET /rooms/{roomID}", s.handleGetRoom)
	mux.HandleFunc("POST /rooms/{roomID}/join", s.handleJoinRoom)
	mux.HandleFunc("POST /rooms/{roomID}/invites", s.handleCreateInvite)
	mux.HandleFunc("POST /invites/{token}/join", s.handleJoinInvite)

	mux.HandleFunc("GET /rooms/{roomID}/queue", s.handleGetQueue)
	mux.HandleFunc("POST /rooms/{roomID}/queue", s.handleAddQueueItem)
	mux.HandleFunc("POST /rooms/{roomID}/queue/batch", s.handleAddQueueBatch)
	mux.HandleFunc("POST /rooms/{roomID}/queue/{songID}/vote", s.handleVoteQueueItem)
	mux.HandleFunc("DELETE /rooms/{roomID}/queue/{songID}", s.handleDeleteQueueItem)
	mux.HandleFunc("POST /rooms/{roomID}/queue/next", s.handleNextQueueItem)

	mux.HandleFunc("POST /rooms/{roomID}/play", s.handlePlayNow)
	mux.HandleFunc("POST /rooms/{roomID}/control", s.handlePlaybackControl)
	mux.HandleFunc("DELETE /rooms/{roomID}/users/{userID}", s.handleRemoveUser)

	mux.HandleFunc("GET /search", s.handleSearch)
	mux.HandleFunc("GET /playlist", s.handlePlaylist)
}

// publish fans an event out to everyone in the room. REST mutations go through
// here so peers hear about changes even if the mutating client is reconnecting.
func (s *Server) publish(roomID, action string, data map[string]any) {
	event, err := json.Marshal(models.WSEvent{
		Action:    action,
		Data:      data,
		Timestamp: time.Now().UnixMilli(),
	})
	if err != nil {
		log.Printf("failed to encode %s event: %v", action, err)
		return
	}
	if err := s.rooms.PublishRoomEvent(s.ctx, roomID, event); err != nil {
		log.Printf("failed to publish %s event: %v", action, err)
	}
}

// Events carry the new value rather than a bare "something changed" nudge, so
// N listeners don't answer every vote with N refetches.
func (s *Server) publishQueue(roomID string, queue []models.QueueItem) {
	s.publish(roomID, "queue:updated", map[string]any{"queue": queue})
}

func (s *Server) publishState(roomID string, state models.RoomState) {
	s.publish(roomID, "state:updated", map[string]any{"state": state})
}
