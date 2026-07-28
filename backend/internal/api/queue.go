package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"songspot/internal/models"
)

func (s *Server) handleGetQueue(w http.ResponseWriter, r *http.Request) {
	room, err := s.rooms.GetRoom(s.ctx, roomIDFrom(r))
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, room.Queue)
}

func (s *Server) handleAddQueueItem(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDFrom(r)

	var newSong models.Song
	if err := json.NewDecoder(r.Body).Decode(&newSong); err != nil {
		http.Error(w, "Invalid song data", http.StatusBadRequest)
		return
	}
	if newSong.ID == "" {
		http.Error(w, "song id is required", http.StatusBadRequest)
		return
	}

	room, err := s.rooms.GetRoom(s.ctx, roomID)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	// Don't queue the same song twice; the vote is how you push it up.
	for _, item := range room.Queue {
		if item.Song.ID == newSong.ID {
			http.Error(w, "That song is already in the queue", http.StatusConflict)
			return
		}
	}

	room.Queue = append(room.Queue, models.QueueItem{Song: newSong})

	if err := s.rooms.SaveRoom(s.ctx, roomID, room); err != nil {
		http.Error(w, "Failed to save queue", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, room.Queue)
	s.publishQueue(roomID, room.Queue)
}

// Append many songs in one write, used by playlist import to avoid N round
// trips and N racing read-modify-writes.
func (s *Server) handleAddQueueBatch(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDFrom(r)

	var req struct {
		Songs []models.Song `json:"songs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid songs data", http.StatusBadRequest)
		return
	}
	if len(req.Songs) == 0 {
		http.Error(w, "songs is required", http.StatusBadRequest)
		return
	}

	room, err := s.rooms.GetRoom(s.ctx, roomID)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	// Dedupe against what's already queued and within the batch itself.
	seen := make(map[string]struct{}, len(room.Queue)+len(req.Songs))
	for _, item := range room.Queue {
		seen[item.Song.ID] = struct{}{}
	}
	for _, song := range req.Songs {
		if song.ID == "" {
			continue
		}
		if _, dup := seen[song.ID]; dup {
			continue
		}
		seen[song.ID] = struct{}{}
		room.Queue = append(room.Queue, models.QueueItem{Song: song})
	}

	if err := s.rooms.SaveRoom(s.ctx, roomID, room); err != nil {
		http.Error(w, "Failed to save queue", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, room.Queue)
	s.publishQueue(roomID, room.Queue)
}

func (s *Server) handleVoteQueueItem(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDFrom(r)
	songID := r.PathValue("songID")
	userID := r.URL.Query().Get("userID")
	if userID == "" {
		http.Error(w, "userID is required", http.StatusBadRequest)
		return
	}

	room, err := s.rooms.GetRoom(s.ctx, roomID)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	found := false
	for i := range room.Queue {
		if room.Queue[i].Song.ID != songID {
			continue
		}
		item := &room.Queue[i]

		idx := -1
		for k, voter := range item.Voters {
			if voter == userID {
				idx = k
				break
			}
		}
		if idx >= 0 {
			item.Voters = append(item.Voters[:idx], item.Voters[idx+1:]...)
		} else {
			item.Voters = append(item.Voters, userID)
		}
		item.Votes = len(item.Voters)
		found = true
		break
	}
	if !found {
		http.Error(w, "Song not found in queue", http.StatusNotFound)
		return
	}

	sort.SliceStable(room.Queue, func(i, j int) bool {
		return room.Queue[i].Votes > room.Queue[j].Votes
	})

	if err := s.rooms.SaveRoom(s.ctx, roomID, room); err != nil {
		http.Error(w, "Failed to save vote", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, room.Queue)
	s.publishQueue(roomID, room.Queue)
}

func (s *Server) handleDeleteQueueItem(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDFrom(r)
	songID := r.PathValue("songID")

	room, err := s.rooms.GetRoom(s.ctx, roomID)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	// Removing songs is a control action: host only, unless control is open.
	if !mayControlPlayback(room, r.URL.Query().Get("userID")) {
		http.Error(w, "Only the host can remove songs", http.StatusForbidden)
		return
	}

	found := false
	updatedQueue := make([]models.QueueItem, 0, len(room.Queue))
	for _, item := range room.Queue {
		if item.Song.ID != songID {
			updatedQueue = append(updatedQueue, item)
			continue
		}
		found = true
	}
	if !found {
		http.Error(w, "Song not found in queue", http.StatusNotFound)
		return
	}
	room.Queue = updatedQueue

	if err := s.rooms.SaveRoom(s.ctx, roomID, room); err != nil {
		http.Error(w, "Failed to update queue", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, room.Queue)
	s.publishQueue(roomID, room.Queue)
}

func (s *Server) handleNextQueueItem(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDFrom(r)

	var req struct {
		UserID      string `json:"userID"`
		AfterSongID string `json:"afterSongID"`
	}
	if err := decodeOptionalJSON(r, &req); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}
	userID := req.UserID
	if userID == "" {
		userID = r.URL.Query().Get("userID")
	}

	room, err := s.rooms.GetRoom(s.ctx, roomID)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	if req.AfterSongID != "" && req.AfterSongID != room.State.CurrentSong {
		writeJSON(w, http.StatusOK, room.State)
		return
	}

	ended := req.AfterSongID != "" && room.State.CurrentSongFinished(time.Now().UnixMilli())
	if !ended && !mayControlPlayback(room, userID) {
		http.Error(w, "Only the host can control playback", http.StatusForbidden)
		return
	}

	if len(room.Queue) == 0 {
		http.Error(w, "Queue is empty", http.StatusBadRequest)
		return
	}

	next := room.Queue[0].Song
	room.State.CurrentSong = next.ID
	room.State.NowPlaying = &next
	room.State.IsPlaying = true
	room.State.SyncTimeMs = 0
	room.State.UpdatedAt = time.Now().UnixMilli()
	room.Queue = room.Queue[1:]

	if err := s.rooms.SaveRoom(s.ctx, roomID, room); err != nil {
		http.Error(w, "Failed to advance queue", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, room.State)
	s.publishState(roomID, room.State)
	s.publishQueue(roomID, room.Queue)
}
