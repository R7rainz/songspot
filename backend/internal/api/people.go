package api

import "net/http"

// Host-only: remove a participant and tell their client to leave.
func (s *Server) handleRemoveUser(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDFrom(r)
	targetID := r.PathValue("userID")
	requesterID := r.URL.Query().Get("requesterID")

	room, err := s.rooms.GetRoom(s.ctx, roomID)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	if requesterID != room.State.HostID {
		http.Error(w, "Only the host can remove people", http.StatusForbidden)
		return
	}
	if targetID == room.State.HostID {
		http.Error(w, "The host can't be removed", http.StatusBadRequest)
		return
	}

	kept := make([]string, 0, len(room.Users))
	for _, userID := range room.Users {
		if userID != targetID {
			kept = append(kept, userID)
		}
	}
	room.Users = kept

	if err := s.rooms.SaveRoom(s.ctx, roomID, room); err != nil {
		http.Error(w, "Failed to update room", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, room.Users)
	s.publish(roomID, "kicked", map[string]any{"userID": targetID})
}
