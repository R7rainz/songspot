package main

import (
	"context"
	"log"
	"net/http"
	"strings"

	"songspot/internal/api"
	"songspot/internal/redisconn"
	"songspot/internal/store"

	"github.com/caitlinelfring/go-env-default"
)

func main() {
	redisURL := env.GetDefault("REDIS_URL", "localhost:6380")

	rdb, err := redisconn.Connect(context.Background(), redisURL)
	if err != nil {
		log.Fatalf("Failed to connect to Redis: %v", err)
	}
	defer rdb.Close()

	log.Println("Successfully connected to redis")

	// setup http router
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})

	// Registers the REST routes and the /ws upgrade handler, which share the
	// room-hub registry.
	api.SetupRestRoutes(mux, store.NewRedisStore(rdb))

	port := env.GetDefault("PORT", "8080")

	log.Printf("Starting SongSpot WebSocket Server on port %s...", port)

	if err := http.ListenAndServe(":"+port, withCORS(mux)); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

// withCORS lets a separately-hosted frontend call the REST API. Origins come
// from CORS_ORIGIN (comma-separated, or "*"); defaults to "*" so it works out of
// the box. No credentials are used, so echoing the caller's origin is safe.
// (WebSocket origins are checked separately via WS_ALLOWED_ORIGINS.)
func withCORS(next http.Handler) http.Handler {
	allowed := strings.Split(env.GetDefault("CORS_ORIGIN", "*"), ",")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := matchOrigin(r.Header.Get("Origin"), allowed); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "86400")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func matchOrigin(origin string, allowed []string) string {
	if origin == "" {
		return ""
	}
	for _, a := range allowed {
		switch strings.TrimSpace(a) {
		case "*", origin:
			return origin
		}
	}
	return ""
}
