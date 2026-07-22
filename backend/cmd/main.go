package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"songspot/internal/api"

	"github.com/redis/go-redis/v9"
)

func main() {
	redisURL := "localhost:6380"
	if url := os.Getenv("REDIS_URL"); url != "" {
		redisURL = url
	}

	rdb := redis.NewClient(&redis.Options{
		Addr:     redisURL,
		Password: "",
		DB:       0,
	})

	if err := rdb.Ping(context.Background()).Err(); err != nil {
		log.Fatalf("Failed to connect to Redis at %s: %v", redisURL, err)
	}

	log.Println("Successfully connected to redis")

	// setup http router
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status": "ok"}`))
	})

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.URL.Query().Get("roomID")
		userID := r.URL.Query().Get("userID")

		api.ServerWs(w, r, roomID, userID, rdb)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("Starting SongSpot WebSocket Server on port %s...", port)

	err := http.ListenAndServe(":"+port, mux)
	if err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
