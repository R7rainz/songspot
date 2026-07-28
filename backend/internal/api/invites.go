package api

import (
	"net/http"
	"time"

	"songspot/internal/models"

	"github.com/google/uuid"
)

// Invite tokens predate short room codes and are no longer how the UI shares a
// room. They stay so links handed out earlier keep working.
func (s *Server) handleCreateInvite(w http.ResponseWriter, r *http.Request) {
	roomID := roomIDFrom(r)

	exists, err := s.rooms.RoomExists(s.ctx, roomID)
	if err != nil || !exists {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	var req CreateInviteRequest
	if err := decodeOptionalJSON(r, &req); err != nil {
		http.Error(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}
	if req.MaxUses <= 0 {
		req.MaxUses = 5
	}
	if req.ValidHours <= 0 {
		req.ValidHours = 24
	}

	token := uuid.New().String()
	invite := models.InviteToken{
		RoomID:    roomID,
		ExpiresAt: time.Now().Add(time.Duration(req.ValidHours) * time.Hour),
		MaxUses:   req.MaxUses,
	}

	if err := s.rooms.SaveInvite(s.ctx, token, invite); err != nil {
		http.Error(w, "Failed to save invite to Redis", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"token":     token,
		"expiresAt": invite.ExpiresAt,
		"maxUses":   invite.MaxUses,
	})
}

func (s *Server) handleJoinInvite(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")

	invite, err := s.rooms.GetInvite(s.ctx, token)
	if err != nil {
		http.Error(w, "Invalid or expired invite token", http.StatusBadRequest)
		return
	}

	if time.Now().After(invite.ExpiresAt) || invite.Uses >= invite.MaxUses {
		http.Error(w, "Invite token has expired or reached max uses", http.StatusForbidden)
		return
	}

	// Load the room before spending a use, so a dead room doesn't burn one.
	room, err := s.rooms.GetRoom(s.ctx, invite.RoomID)
	if err != nil {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	invite.Uses++
	if err := s.rooms.SaveInvite(s.ctx, token, *invite); err != nil {
		http.Error(w, "Failed to update invite", http.StatusInternalServerError)
		return
	}

	newUserID := "user_" + uuid.New().String()[:6]
	room.Users = append(room.Users, newUserID)
	if err := s.rooms.SaveRoom(s.ctx, invite.RoomID, room); err != nil {
		http.Error(w, "Failed to update room", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"roomId": room.State.RoomID,
		"userId": newUserID,
	})
}
