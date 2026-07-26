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
	"slices"
	"songspot/internal/models"
	"songspot/internal/music"
	"songspot/internal/ws"
	"sort"
	"strconv"
	"strings"
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
		for allowedOrigin := range strings.SplitSeq(allowedOrigins, ",") {
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

func SetupRestRoutes(mux *http.ServeMux, rdb *redis.Client) {
	ctx := context.Background()

	// Keyless YouTube search + playlist import (see internal/music).
	musicProvider := music.NewInnerTube()

	// One registry for the whole process; it starts a hub per room on the first
	// listener and stops it when the last one leaves.
	registry := ws.NewRegistry(rdb)

	getRoom := func(roomID string) (*models.RoomData, error) {
		dataStr, err := rdb.Get(ctx, "room:"+roomID).Result()
		if err != nil {
			return nil, err
		}
		var room models.RoomData
		err = json.Unmarshal([]byte(dataStr), &room)
		return &room, err
	}

	saveRoom := func(roomID string, room *models.RoomData) error {
		data, err := json.Marshal(room)
		if err != nil {
			return err
		}
		return rdb.Set(ctx, "room:"+roomID, data, models.RoomTTL).Err()
	}

	// publish fans an event out to everyone in the room. REST mutations go
	// through here so peers hear about changes from the server. They used to
	// depend on the mutating client announcing its own change over its socket,
	// which silently did nothing whenever that client was mid-reconnect.
	publish := func(roomID, action string, data map[string]any) {
		event, err := json.Marshal(models.WSEvent{
			Action:    action,
			Data:      data,
			Timestamp: time.Now().UnixMilli(),
		})
		if err != nil {
			log.Printf("failed to encode %s event: %v", action, err)
			return
		}
		if err := rdb.Publish(ctx, "room_events:"+roomID, event).Err(); err != nil {
			log.Printf("failed to publish %s event: %v", action, err)
		}
	}

	// Events carry the new value rather than a bare "something changed" nudge,
	// so N listeners don't answer every vote with N refetches.
	publishQueue := func(roomID string, queue []models.QueueItem) {
		publish(roomID, "queue:updated", map[string]any{"queue": queue})
	}
	publishState := func(roomID string, state models.RoomState) {
		publish(roomID, "state:updated", map[string]any{"state": state})
	}

	// --- WebSocket -----------------------------------------------------------

	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		roomID := models.NormalizeRoomID(r.URL.Query().Get("roomID"))
		userID := strings.TrimSpace(r.URL.Query().Get("userID"))
		if roomID == "" || userID == "" {
			http.Error(w, "roomID and userID are required", http.StatusBadRequest)
			return
		}

		// Refuse unknown rooms before upgrading. Otherwise a typo'd code would
		// spin up a hub and a Redis subscription for a room that never existed.
		if exists, err := rdb.Exists(ctx, "room:"+roomID).Result(); err != nil || exists == 0 {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("Upgrade error: ", err)
			return
		}

		client := ws.NewClient(userID, conn)
		registry.Join(roomID, client)

		go client.WritePump()
		go client.ReadPump()
	})

	// --- Rooms ---------------------------------------------------------------

	mux.HandleFunc("POST /rooms", func(w http.ResponseWriter, r *http.Request) {
		var req CreateRoomRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.HostID == "" {
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
					// wall-clock time. Seeding it with a timestamp used to put a
					// brand-new room's playhead ~54 years into the first track.
					SyncTimeMs: 0,
					UpdatedAt:  now,
				},
				Queue: []models.QueueItem{},
				Users: []string{req.HostID},
			}

			data, err := json.Marshal(room)
			if err != nil {
				http.Error(w, "Internal server error", http.StatusInternalServerError)
				return
			}

			ok, err := rdb.SetNX(ctx, "room:"+code, data, models.RoomTTL).Result()
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
	})

	mux.HandleFunc("GET /rooms/{roomID}", func(w http.ResponseWriter, r *http.Request) {
		room, err := getRoom(roomIDFrom(r))
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, room)
	})

	// Join straight from a room code. This is the main way in: it confirms the
	// room exists before the client opens a socket, and it puts the caller on
	// the roster, which previously only happened via an invite token — so
	// anyone who joined by code was invisible to the server.
	mux.HandleFunc("POST /rooms/{roomID}/join", func(w http.ResponseWriter, r *http.Request) {
		roomID := roomIDFrom(r)

		var req struct {
			UserID string `json:"userID"`
		}
		if err := decodeOptionalJSON(r, &req); err != nil {
			http.Error(w, "Invalid JSON body", http.StatusBadRequest)
			return
		}

		room, err := getRoom(roomID)
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
			if err := saveRoom(roomID, room); err != nil {
				http.Error(w, "Failed to join room", http.StatusInternalServerError)
				return
			}
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"roomId": room.State.RoomID,
			"userId": userID,
		})
	})

	// --- Invites -------------------------------------------------------------
	//
	// Invite tokens predate short room codes and are no longer how the UI shares
	// a room (the code is). They stay so links handed out earlier keep working.

	mux.HandleFunc("POST /rooms/{roomID}/invites", func(w http.ResponseWriter, r *http.Request) {
		roomID := roomIDFrom(r)

		if exists, err := rdb.Exists(ctx, "room:"+roomID).Result(); err != nil || exists == 0 {
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

		tokenStr := uuid.New().String()
		invite := InviteToken{
			RoomID:    roomID,
			ExpiresAt: time.Now().Add(time.Duration(req.ValidHours) * time.Hour),
			MaxUses:   req.MaxUses,
		}

		inviteData, err := json.Marshal(invite)
		if err != nil {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		if err := rdb.Set(ctx, "invite:"+tokenStr, inviteData, time.Until(invite.ExpiresAt)).Err(); err != nil {
			http.Error(w, "Failed to save invite to Redis", http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{
			"token":     tokenStr,
			"expiresAt": invite.ExpiresAt,
			"maxUses":   invite.MaxUses,
		})
	})

	mux.HandleFunc("POST /invites/{token}/join", func(w http.ResponseWriter, r *http.Request) {
		inviteKey := "invite:" + r.PathValue("token")

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

		// Load the room before spending a use, so a dead room doesn't burn one.
		room, err := getRoom(invite.RoomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		invite.Uses++
		updatedInvite, err := json.Marshal(invite)
		if err != nil {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		if err := rdb.Set(ctx, inviteKey, updatedInvite, time.Until(invite.ExpiresAt)).Err(); err != nil {
			http.Error(w, "Failed to update invite", http.StatusInternalServerError)
			return
		}

		newUserID := "user_" + uuid.New().String()[:6]
		room.Users = append(room.Users, newUserID)
		if err := saveRoom(invite.RoomID, room); err != nil {
			http.Error(w, "Failed to update room", http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"roomId": room.State.RoomID,
			"userId": newUserID,
		})
	})

	// --- Queue ---------------------------------------------------------------

	mux.HandleFunc("GET /rooms/{roomID}/queue", func(w http.ResponseWriter, r *http.Request) {
		room, err := getRoom(roomIDFrom(r))
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, room.Queue)
	})

	mux.HandleFunc("POST /rooms/{roomID}/queue", func(w http.ResponseWriter, r *http.Request) {
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

		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		// Don't queue the same song twice — the vote is how you push it up.
		for _, item := range room.Queue {
			if item.Song.ID == newSong.ID {
				http.Error(w, "That song is already in the queue", http.StatusConflict)
				return
			}
		}

		room.Queue = append(room.Queue, models.QueueItem{Song: newSong})

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to save queue", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.Queue)
		publishQueue(roomID, room.Queue)
	})

	// Append many songs in one write — used by playlist import to avoid N round
	// trips and N racing read-modify-writes.
	mux.HandleFunc("POST /rooms/{roomID}/queue/batch", func(w http.ResponseWriter, r *http.Request) {
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

		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		// Dedupe against what's already queued and within the batch itself —
		// playlists overlap, and a queue holding the same song twice renders as
		// two rows that vote and delete as one.
		seen := make(map[string]struct{}, len(room.Queue)+len(req.Songs))
		for _, item := range room.Queue {
			seen[item.Song.ID] = struct{}{}
		}
		for _, s := range req.Songs {
			if s.ID == "" {
				continue
			}
			if _, dup := seen[s.ID]; dup {
				continue
			}
			seen[s.ID] = struct{}{}
			room.Queue = append(room.Queue, models.QueueItem{Song: s})
		}

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to save queue", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.Queue)
		publishQueue(roomID, room.Queue)
	})

	mux.HandleFunc("POST /rooms/{roomID}/queue/{songID}/vote", func(w http.ResponseWriter, r *http.Request) {
		roomID := roomIDFrom(r)
		songID := r.PathValue("songID")
		userID := r.URL.Query().Get("userID")
		if userID == "" {
			http.Error(w, "userID is required", http.StatusBadRequest)
			return
		}

		room, err := getRoom(roomID)
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
			// One vote per user: toggle this user in/out of the voter set.
			idx := -1
			for k, v := range item.Voters {
				if v == userID {
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

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to save vote", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.Queue)
		publishQueue(roomID, room.Queue)
	})

	mux.HandleFunc("DELETE /rooms/{roomID}/queue/{songID}", func(w http.ResponseWriter, r *http.Request) {
		roomID := roomIDFrom(r)
		songID := r.PathValue("songID")

		room, err := getRoom(roomID)
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

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to update queue", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.Queue)
		publishQueue(roomID, room.Queue)
	})

	mux.HandleFunc("POST /rooms/{roomID}/queue/next", func(w http.ResponseWriter, r *http.Request) {
		roomID := roomIDFrom(r)

		var req struct {
			UserID string `json:"userID"`
			// AfterSongID names the song the caller believes is playing. When
			// set, this call only advances if that is still true — which makes
			// end-of-song advancing safe to fire from every client at once:
			// exactly one wins and the rest no-op instead of skipping the queue
			// N songs forward.
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

		room, err := getRoom(roomID)
		if err != nil {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		if req.AfterSongID != "" && req.AfterSongID != room.State.CurrentSong {
			// Someone already advanced past it; report the state we settled on.
			writeJSON(w, http.StatusOK, room.State)
			return
		}

		// A track that has genuinely run to its end may be advanced by anyone,
		// even in a host-only room. Otherwise a room whose host closed their tab
		// would sit on a finished song forever. The AfterSongID guard means this
		// can still only ever move the queue one step, right when it was going
		// to move anyway.
		ended := req.AfterSongID != "" && room.State.CurrentSongFinished(time.Now().UnixMilli())
		if !ended && !mayControlPlayback(room, userID) {
			http.Error(w, "Only the host can control playback", http.StatusForbidden)
			return
		}

		if len(room.Queue) == 0 {
			http.Error(w, "Queue is empty", http.StatusBadRequest)
			return
		}

		// The top song becomes the current song.
		next := room.Queue[0].Song
		room.State.CurrentSong = next.ID
		room.State.NowPlaying = &next
		room.State.IsPlaying = true
		room.State.SyncTimeMs = 0 // new song, back to the start
		room.State.UpdatedAt = time.Now().UnixMilli()
		room.Queue = room.Queue[1:]

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to advance queue", http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusOK, room.State)
		publishState(roomID, room.State)
		publishQueue(roomID, room.Queue)
	})

	// --- Playback ------------------------------------------------------------

	// Set the room's current song directly, powering "Play now" from a search
	// result (unlike queue/next, which only pops the top of the queue).
	mux.HandleFunc("POST /rooms/{roomID}/play", func(w http.ResponseWriter, r *http.Request) {
		roomID := roomIDFrom(r)

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

		song := req.Song
		room.State.CurrentSong = song.ID
		room.State.NowPlaying = &song
		room.State.IsPlaying = true
		room.State.SyncTimeMs = 0
		room.State.UpdatedAt = time.Now().UnixMilli()

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to update playback", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.State)
		publishState(roomID, room.State)
	})

	// Host-only: hand playback control to everyone, or take it back.
	mux.HandleFunc("POST /rooms/{roomID}/control", func(w http.ResponseWriter, r *http.Request) {
		roomID := roomIDFrom(r)

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

		// Only flip the permission — do NOT touch UpdatedAt/SyncTimeMs. Those
		// are the playback anchor; moving UpdatedAt without SyncTimeMs would
		// make every listener think the song had jumped backwards.
		room.State.EveryoneControls = req.EveryoneControls

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to update room", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.State)
		publishState(roomID, room.State)
	})

	// --- People --------------------------------------------------------------

	// Host-only: remove a participant and tell their client to leave.
	mux.HandleFunc("DELETE /rooms/{roomID}/users/{userID}", func(w http.ResponseWriter, r *http.Request) {
		roomID := roomIDFrom(r)
		targetID := r.PathValue("userID")
		requesterID := r.URL.Query().Get("requesterID")

		room, err := getRoom(roomID)
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
		for _, u := range room.Users {
			if u != targetID {
				kept = append(kept, u)
			}
		}
		room.Users = kept

		if err := saveRoom(roomID, room); err != nil {
			http.Error(w, "Failed to update room", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, room.Users)
		publish(roomID, "kicked", map[string]any{"userID": targetID})
	})

	// --- Music lookup --------------------------------------------------------

	// Search YouTube for songs to add without leaving the app. Results are
	// cached in Redis for an hour so repeat queries don't re-hit YouTube.
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

	// Preview a YouTube playlist's tracks without mutating any room. Handles
	// both regular playlists and YouTube-generated Mixes (RD…), which resolve
	// differently (Mixes come from the seed video's "up next" panel).
	mux.HandleFunc("GET /playlist", func(w http.ResponseWriter, r *http.Request) {
		raw := r.URL.Query().Get("url")
		playlistID := music.ParsePlaylistID(raw)
		if playlistID == "" {
			http.Error(w, "a valid playlist url is required", http.StatusBadRequest)
			return
		}

		var songs []models.Song
		var err error
		if music.IsMixPlaylist(playlistID) {
			songs, err = musicProvider.Mix(r.Context(), playlistID, music.ParseSeedVideoID(raw))
		} else {
			songs, err = musicProvider.Playlist(r.Context(), playlistID)
		}
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
}
