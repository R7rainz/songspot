package api

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"songspot/internal/models"
	"songspot/internal/music"
	"songspot/internal/store"
)

// Search YouTube for songs to add without leaving the app. Results are cached
// in Redis for an hour so repeat queries don't re-hit YouTube.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
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

	cacheKey := store.SearchCacheKey(query, limit)
	if cached, err := s.rooms.GetSearchCache(s.ctx, cacheKey); err == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, cached)
		return
	}

	songs, err := s.musicProvider.Search(r.Context(), query, limit)
	if err != nil {
		log.Printf("search %q failed: %v", query, err)
		http.Error(w, "Search is unavailable right now", http.StatusBadGateway)
		return
	}
	if data, err := json.Marshal(songs); err == nil {
		if err := s.rooms.SaveSearchCache(s.ctx, cacheKey, data, time.Hour); err != nil {
			log.Printf("failed to cache search %q: %v", query, err)
		}
	}
	writeJSON(w, http.StatusOK, songs)
}

// Preview a YouTube playlist's tracks without mutating any room. Handles both
// regular playlists and YouTube-generated Mixes.
func (s *Server) handlePlaylist(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	playlistID := music.ParsePlaylistID(raw)
	if playlistID == "" {
		http.Error(w, "a valid playlist url is required", http.StatusBadRequest)
		return
	}

	var songs []models.Song
	var err error
	if music.IsMixPlaylist(playlistID) {
		songs, err = s.musicProvider.Mix(r.Context(), playlistID, music.ParseSeedVideoID(raw))
	} else {
		songs, err = s.musicProvider.Playlist(r.Context(), playlistID)
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
}
