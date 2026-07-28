package api

import (
	"log"
	"net/http"
	"strings"

	"songspot/internal/models"
	"songspot/internal/ws"
)

var upgrader = ws.NewUpgrader()

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	roomID := models.NormalizeRoomID(r.URL.Query().Get("roomID"))
	userID := strings.TrimSpace(r.URL.Query().Get("userID"))
	if roomID == "" || userID == "" {
		http.Error(w, "roomID and userID are required", http.StatusBadRequest)
		return
	}

	// Refuse unknown rooms before upgrading. Otherwise a typo'd code would spin
	// up a hub and a Redis subscription for a room that never existed.
	exists, err := s.rooms.RoomExists(s.ctx, roomID)
	if err != nil || !exists {
		http.Error(w, "Room not found", http.StatusNotFound)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error: ", err)
		return
	}

	client := ws.NewClient(userID, conn)
	s.registry.Join(roomID, client)

	go client.WritePump()
	go client.ReadPump()
}
