package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"

	"songspot/internal/models"
)

type CreateRoomRequest struct {
	HostID string `json:"hostID"`
}

type CreateInviteRequest struct {
	MaxUses    int `json:"maxUses"`
	ValidHours int `json:"validHours"`
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("failed to write JSON response: %v", err)
	}
}

// decodeOptionalJSON decodes a request body that callers are allowed to omit.
func decodeOptionalJSON(r *http.Request, dst any) error {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// roomIDFrom pulls the room id out of the path and canonicalises it, so
// "k4m9tq" and "K4M 9TQ" both reach room K4M9TQ.
func roomIDFrom(r *http.Request) string {
	return models.NormalizeRoomID(r.PathValue("roomID"))
}

// mayControlPlayback reports whether userID is allowed to drive playback in the
// room: always the host, and everyone else only when the host has opened it up.
func mayControlPlayback(room *models.RoomData, userID string) bool {
	return room.State.EveryoneControls || userID == room.State.HostID
}
