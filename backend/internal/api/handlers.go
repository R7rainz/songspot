package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"songspot/internal/models"
	"songspot/internal/ws"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,

	CheckOrigin: func(r *http.Request) bool {
		return isAllowedWebSocketOrigin(r)
	},
}

func isAllowedWebSocketOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}

	if allowedOrigins := os.Getenv("WS_ALLOWED_ORIGINS"); allowedOrigins != "" {
		for _, allowedOrigin := range strings.Split(allowedOrigins, ",") {
			if strings.TrimSpace(allowedOrigin) == origin {
				return true
			}
		}
		return false
	}

	parsedOrigin, err := url.Parse(origin)
	if err != nil {
		return false
	}

	if strings.EqualFold(parsedOrigin.Host, r.Host) {
		return true
	}

	originHost := parsedOrigin.Hostname()
	return originHost == "localhost" || originHost == "127.0.0.1"
}

var (
	hubs      = make(map[string]*ws.Hub)
	hubsMutex sync.Mutex
)

func GetOrCreateHub(roomID string, redisClient *redis.Client) *ws.Hub {
	hubsMutex.Lock()
	defer hubsMutex.Unlock()

	if hub, exists := hubs[roomID]; exists {
		return hub
	}

	hub := ws.NewHub(roomID, redisClient)
	hubs[roomID] = hub

	// Start the hub's local event look and redis listener
	go hub.Run()
	return hub
}

// handles the initial GET request and upgrades it to a websocket
func ServerWs(w http.ResponseWriter, r *http.Request, roomID string, userID string, redisClient *redis.Client) {
	if roomID == "" || userID == "" {
		http.Error(w, "roomId and userId are required", http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error: ", err)
		return
	}

	hub := GetOrCreateHub(roomID, redisClient)

	client := &ws.Client{
		Hub:    hub,
		UserID: userID,
		Conn:   conn,
		Send:   make(chan []byte, 256),
	}

	client.Hub.Register <- client

	go client.WritePump()
	go client.ReadPump()
}

type InviteToken struct {
	RoomID    string    `json:"roomID"`
	ExpiresAt time.Time `json:"expiresAt"`
	MaxUses   int       `json:"maxUses"`
	Uses      int       `json:"uses"`
}

type CreateRoomRequest struct {
	HostID string `json:"hostID"`
}

type CreateInviteRequest struct {
	MaxUses    int `json:"maxUses"`
	ValidHours int `json:"validHours"`
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("failed to write JSON response: %v", err)
	}
}

func SetupRestRoutes(mux *http.ServeMux, rdb *redis.Client) {
	ctx := context.Background()

	mux.HandleFunc("/rooms", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req CreateRoomRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.HostID == "" {
			http.Error(w, "hostID is required", http.StatusBadRequest)
			return
		}

		roomID := "room_" + uuid.New().String()[:8]
		roomKey := "room:" + roomID

		now := time.Now().UnixMilli()
		initialData := models.RoomData{
			State: models.RoomState{
				RoomID:      roomID,
				HostID:      req.HostID,
				CurrentSong: "",
				IsPlaying:   false,
				SyncTimeMs:  now,
				UpdatedAt:   now,
			},
			Queue: []models.QueueItem{},
			Users: []string{req.HostID},
		}

		data, err := json.Marshal(initialData)
		if err != nil {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		if err := rdb.Set(ctx, roomKey, data, 0).Err(); err != nil {
			http.Error(w, "Failed to save room to Redis", http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusCreated, initialData)
	})

	mux.HandleFunc("/rooms/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/rooms/")
		parts := strings.Split(path, "/")

		if len(parts) == 2 && parts[1] == "invites" {
			if r.Method != http.MethodPost {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}

			roomID := parts[0]
			roomKey := "room:" + roomID

			if _, err := rdb.Get(ctx, roomKey).Result(); err != nil {
				http.Error(w, "Room not found", http.StatusNotFound)
				return
			}

			var req CreateInviteRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
				http.Error(w, "Invalid JSON body", http.StatusBadRequest)
				return
			}
			if req.MaxUses <= 0 {
				req.MaxUses = 5
			}
			if req.ValidHours <= 0 {
				req.ValidHours = 24
			}

			tokenStr := uuid.New().String()
			inviteKey := "invite:" + tokenStr

			invite := InviteToken{
				RoomID:    roomID,
				ExpiresAt: time.Now().Add(time.Duration(req.ValidHours) * time.Hour),
				MaxUses:   req.MaxUses,
				Uses:      0,
			}

			inviteData, err := json.Marshal(invite)
			if err != nil {
				http.Error(w, "Internal server error", http.StatusInternalServerError)
				return
			}

			if err := rdb.Set(ctx, inviteKey, inviteData, time.Until(invite.ExpiresAt)).Err(); err != nil {
				http.Error(w, "Failed to save invite to Redis", http.StatusInternalServerError)
				return
			}

			writeJSON(w, http.StatusCreated, map[string]interface{}{
				"token":     tokenStr,
				"expiresAt": invite.ExpiresAt,
				"maxUses":   invite.MaxUses,
			})
			return
		}

		if len(parts) == 1 && parts[0] != "" {
			if r.Method != http.MethodGet {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}

			roomID := parts[0]
			roomKey := "room:" + roomID

			roomDataStr, err := rdb.Get(ctx, roomKey).Result()
			if err != nil {
				http.Error(w, "Room not found", http.StatusNotFound)
				return
			}

			var roomData models.RoomData
			if err := json.Unmarshal([]byte(roomDataStr), &roomData); err != nil {
				http.Error(w, "Stored room data is invalid", http.StatusInternalServerError)
				return
			}

			writeJSON(w, http.StatusOK, roomData)
			return
		}
		http.NotFound(w, r)
	})

	// /invite/{token}/join - validate invite, return roomID , create/accept userID
	mux.HandleFunc("/invites/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		path := strings.TrimPrefix(r.URL.Path, "/invites/")
		parts := strings.Split(path, "/")

		if len(parts) == 2 && parts[1] == "join" {
			token := parts[0]
			inviteKey := "invite:" + token

			inviteData, err := rdb.Get(ctx, inviteKey).Result()
			if err != nil {
				http.Error(w, "Invalid or expired invite token", http.StatusBadRequest)
				return
			}
			var invite InviteToken
			if err := json.Unmarshal([]byte(inviteData), &invite); err != nil {
				http.Error(w, "Stored invite data is invalid", http.StatusInternalServerError)
				return
			}

			if time.Now().After(invite.ExpiresAt) || invite.Uses >= invite.MaxUses {
				http.Error(w, "Invite token has expired or reached max uses", http.StatusForbidden)
				return
			}

			invite.Uses++
			updateInviteData, err := json.Marshal(invite)
			if err != nil {
				http.Error(w, "Internal server error", http.StatusInternalServerError)
				return
			}
			if err := rdb.Set(ctx, inviteKey, updateInviteData, time.Until(invite.ExpiresAt)).Err(); err != nil {
				http.Error(w, "Failed to update invite", http.StatusInternalServerError)
				return
			}

			newUserID := "user_" + uuid.New().String()[:6]

			roomKey := "room:" + invite.RoomID
			roomDataStr, err := rdb.Get(ctx, roomKey).Result()
			if err != nil {
				http.Error(w, "Room not found", http.StatusNotFound)
				return
			}

			var roomData models.RoomData
			if err := json.Unmarshal([]byte(roomDataStr), &roomData); err != nil {
				http.Error(w, "Stored room data is invalid", http.StatusInternalServerError)
				return
			}

			roomData.Users = append(roomData.Users, newUserID)
			updatedRoomData, err := json.Marshal(roomData)
			if err != nil {
				http.Error(w, "Internal server error", http.StatusInternalServerError)
				return
			}
			if err := rdb.Set(ctx, roomKey, updatedRoomData, 0).Err(); err != nil {
				http.Error(w, "Failed to update room", http.StatusInternalServerError)
				return
			}

			writeJSON(w, http.StatusOK, map[string]interface{}{
				"roomId": invite.RoomID,
				"userId": newUserID,
			})
			return
		}
		http.NotFound(w, r)
	})
}
