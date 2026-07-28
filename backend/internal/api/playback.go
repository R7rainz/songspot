package api

import (
	"encoding/json"
	"net/http"
	"time"

	"songspot/internal/models"
)

// Set the room's current song directly, powering "Play now" from a search
// result.
func (s *Server) handlePlayNow(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDFrom(r)

	var req struct {
		Song   models.Song `json:"song"`
		UserID string      `json:"userID"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Song.ID == "" {
		http.Error(w, "song with an id is required", http.StatusBadRequest)
		return
	}

	room, err := s.rooms.GetRoom(s.ctx, roomID)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	if !mayControlPlayback(room, req.UserID) {
		http.Error(w, "Only the host can control playback", http.StatusForbidden)
		return
	}

	song := req.Song
	room.State.CurrentSong = song.ID
	room.State.NowPlaying = &song
	room.State.IsPlaying = true
	room.State.SyncTimeMs = 0
	room.State.UpdatedAt = time.Now().UnixMilli()

	if err := s.rooms.SaveRoom(s.ctx, roomID, room); err != nil {
		http.Error(w, "Failed to update playback", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, room.State)
	s.publishState(roomID, room.State)
}

// Host-only: hand playback control to everyone, or take it back.
func (s *Server) handlePlaybackControl(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDFrom(r)

	var req struct {
		UserID           string `json:"userID"`
		EveryoneControls bool   `json:"everyoneControls"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	room, err := s.rooms.GetRoom(s.ctx, roomID)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	if req.UserID != room.State.HostID {
		http.Error(w, "Only the host can change this", http.StatusForbidden)
		return
	}

	// Only flip the permission; do not touch UpdatedAt/SyncTimeMs because those
	// are the playback anchor.
	room.State.EveryoneControls = req.EveryoneControls

	if err := s.rooms.SaveRoom(s.ctx, roomID, room); err != nil {
		http.Error(w, "Failed to update room", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, room.State)
	s.publishState(roomID, room.State)
}
