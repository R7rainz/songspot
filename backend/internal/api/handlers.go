package api

import (
	"log"
	"net/http"
	"net/url"
	"os"
	"songspot/internal/ws"
	"strings"
	"sync"

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
