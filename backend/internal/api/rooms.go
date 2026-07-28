package api

import (
	"net/http"
	"slices"
	"strings"
	"time"

	"songspot/internal/models"

	"github.com/google/uuid"
)

func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	var req CreateRoomRequest
	if err := decodeOptionalJSON(r, &req); err != nil || strings.TrimSpace(req.HostID) == "" {
		http.Error(w, "hostID is required", http.StatusBadRequest)
		return
	}

	now := time.Now().UnixMilli()
	var created *models.RoomData

	// Claim a code with SetNX so two rooms created at the same instant can
	// never land on the same one. Codes are short by design, so retry a few
	// times before giving up rather than trusting the keyspace blindly.
	for range 8 {
		code, err := models.NewRoomCode()
		if err != nil {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		room := models.RoomData{
			State: models.RoomState{
				RoomID:      code,
				HostID:      req.HostID,
				CurrentSong: "",
				IsPlaying:   false,
				// Anchored at zero: this is a position within a song, not a
				// wall-clock time.
				SyncTimeMs: 0,
				UpdatedAt:  now,
			},
			Queue: []models.QueueItem{},
			Users: []string{req.HostID},
		}

		ok, err := s.rooms.CreateRoomIfAbsent(s.ctx, code, &room)
		if err != nil {
			http.Error(w, "Failed to save room to Redis", http.StatusInternalServerError)
			return
		}
		if ok {
			created = &room
			break
		}
	}

	if created == nil {
		http.Error(w, "Couldn't allocate a room code", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleGetRoom(w http.ResponseWriter, r *http.Request) {
	room, err := s.rooms.GetRoom(s.ctx, roomIDFrom(r))
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, room)
}

// Join straight from a room code. This confirms the room exists before the
// client opens a socket, and puts the caller on the roster.
func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDFrom(r)

	var req struct {
		UserID string `json:"userID"`
	}
	if err := decodeOptionalJSON(r, &req); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}

	room, err := s.rooms.GetRoom(s.ctx, roomID)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	// A returning browser sends the id it already has, so rejoining after a
	// refresh doesn't strand its votes under an id nobody recognises.
	userID := strings.TrimSpace(req.UserID)
	if userID == "" {
		userID = "user_" + uuid.New().String()[:6]
	}

	if !slices.Contains(room.Users, userID) {
		room.Users = append(room.Users, userID)
		if err := s.rooms.SaveRoom(s.ctx, roomID, room); err != nil {
			http.Error(w, "Failed to join room", http.StatusInternalServerError)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"roomId": room.State.RoomID,
		"userId": userID,
	})
}
