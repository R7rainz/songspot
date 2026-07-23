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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"songspot/internal/models"
	"songspot/internal/music"
	"songspot/internal/ws"

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

// mayControlPlayback reports whether userID is allowed to drive playback in the
// room: always the host, and everyone else only when the host has opened it up.
func mayControlPlayback(room *models.RoomData, userID string) bool {
	return room.State.EveryoneControls || userID == room.State.HostID
}

func SetupRestRoutes(mux *http.ServeMux, rdb *redis.Client) {
	ctx := context.Background()

	// Keyless YouTube search + playlist import (see internal/music).
	musicProvider := music.NewInnerTube()

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

	getRoom := func(roomID string) (*models.RoomData, error) {
		roomKey := "room:" + roomID
		dataStr, err := rdb.Get(ctx, roomKey).Result()
		if err != nil {
			return nil, err
		}
		var room models.RoomData
		err = json.Unmarshal([]byte(dataStr), &room)
		return &room, err
	}

	saveRoom := func(roomID string, room *models.RoomData) error {
		roomKey := "room:" + roomID
		data, err := json.Marshal(room)
		if err != nil {
			return err
		}
		return rdb.Set(ctx, roomKey, data, 0).Err()
	}

	mux.HandleFunc("GET /rooms/{roomID}/queue", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")
		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, room.Queue)
	})

	mux.HandleFunc("POST /rooms/{roomID}/queue", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")

		var newSong models.Song
		if err := json.NewDecoder(r.Body).Decode(&newSong); err != nil {
			http.Error(w, "Invalid song data", http.StatusBadRequest)
			return
		}

		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		room.Queue = append(room.Queue, models.QueueItem{
			Song:  newSong,
			Votes: 0,
		})

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to save queue", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.Queue)
	})

	mux.HandleFunc("POST /rooms/{roomID}/queue/{songID}/vote", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")
		songID := r.PathValue("songID")

		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		found := false
		for i := range room.Queue {
			if room.Queue[i].Song.ID == songID {
				room.Queue[i].Votes++
				found = true
				break
			}
		}
		if !found {
			http.Error(w, "Song not found in queue", http.StatusNotFound)
			return
		}

		sort.SliceStable(room.Queue, func(i, j int) bool {
			return room.Queue[i].Votes > room.Queue[j].Votes
		})

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to save vote", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.Queue)
	})

	mux.HandleFunc("DELETE /rooms/{roomID}/queue/{songID}", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")
		songID := r.PathValue("songID")

		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		found := false
		updatedQueue := []models.QueueItem{}
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

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to update queue", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.Queue)
	})

	mux.HandleFunc("POST /rooms/{roomID}/queue/next", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")

		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		if !mayControlPlayback(room, r.URL.Query().Get("userID")) {
			http.Error(w, "Only the host can control playback", http.StatusForbidden)
			return
		}

		if len(room.Queue) == 0 {
			http.Error(w, "Queue is empty", http.StatusBadRequest)
			return
		}

		// the top song becomes current song
		nextSong := room.Queue[0].Song
		room.State.CurrentSong = nextSong.ID
		room.State.IsPlaying = true
		room.State.UpdatedAt = time.Now().UnixMilli()
		room.State.SyncTimeMs = 0 // reset time for new song

		// remove it from queue
		room.Queue = room.Queue[1:]

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to advance queue", http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusOK, room.State)
	})

	// Search YouTube for songs to add without leaving the app. Results are cached
	// in Redis for an hour so repeat queries don't re-hit YouTube.
	mux.HandleFunc("GET /search", func(w http.ResponseWriter, r *http.Request) {
		query := strings.TrimSpace(r.URL.Query().Get("q"))
		if query == "" {
			http.Error(w, "q is required", http.StatusBadRequest)
			return
		}

		limit := 15
		if l := r.URL.Query().Get("limit"); l != "" {
			if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 50 {
				limit = n
			}
		}

		cacheKey := "search:" + strconv.Itoa(limit) + ":" + strings.ToLower(query)
		if cached, err := rdb.Get(ctx, cacheKey).Result(); err == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			io.WriteString(w, cached)
			return
		}

		songs, err := musicProvider.Search(r.Context(), query, limit)
		if err != nil {
			log.Printf("search %q failed: %v", query, err)
			http.Error(w, "Search is unavailable right now", http.StatusBadGateway)
			return
		}
		if data, err := json.Marshal(songs); err == nil {
			rdb.Set(ctx, cacheKey, data, time.Hour)
		}
		writeJSON(w, http.StatusOK, songs)
	})

	// Preview a YouTube playlist's tracks without mutating any room.
	mux.HandleFunc("GET /playlist", func(w http.ResponseWriter, r *http.Request) {
		playlistID := music.ParsePlaylistID(r.URL.Query().Get("url"))
		if playlistID == "" {
			http.Error(w, "a valid playlist url is required", http.StatusBadRequest)
			return
		}
		songs, err := musicProvider.Playlist(r.Context(), playlistID)
		if err != nil {
			log.Printf("playlist %q failed: %v", playlistID, err)
			http.Error(w, "Couldn't load that playlist", http.StatusBadGateway)
			return
		}
		if songs == nil {
			songs = []models.Song{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"songs": songs})
	})

	// Set the room's current song directly, powering "Play now" from a search
	// result (unlike queue/next, which only pops the top of the queue).
	mux.HandleFunc("POST /rooms/{roomID}/play", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")

		var req struct {
			Song   models.Song `json:"song"`
			UserID string      `json:"userID"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Song.ID == "" {
			http.Error(w, "song with an id is required", http.StatusBadRequest)
			return
		}

		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		if !mayControlPlayback(room, req.UserID) {
			http.Error(w, "Only the host can control playback", http.StatusForbidden)
			return
		}

		room.State.CurrentSong = req.Song.ID
		room.State.IsPlaying = true
		room.State.SyncTimeMs = 0
		room.State.UpdatedAt = time.Now().UnixMilli()

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to update playback", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.State)
	})

	// Append many songs to the queue in one write — used by playlist import to
	// avoid N round-trips and N racing read-modify-writes.
	mux.HandleFunc("POST /rooms/{roomID}/queue/batch", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")

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

		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		for _, s := range req.Songs {
			if s.ID == "" {
				continue
			}
			room.Queue = append(room.Queue, models.QueueItem{Song: s, Votes: 0})
		}

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to save queue", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.Queue)
	})

	// Host-only: hand playback control to everyone, or take it back. Returns the
	// updated room state so the caller can broadcast the change to peers.
	mux.HandleFunc("POST /rooms/{roomID}/control", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.PathValue("roomID")

		var req struct {
			UserID           string `json:"userID"`
			EveryoneControls bool   `json:"everyoneControls"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request", http.StatusBadRequest)
			return
		}

		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		if req.UserID != room.State.HostID {
			http.Error(w, "Only the host can change this", http.StatusForbidden)
			return
		}

		room.State.EveryoneControls = req.EveryoneControls
		room.State.UpdatedAt = time.Now().UnixMilli()

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to update room", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.State)
	})
}
