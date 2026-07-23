// Package music resolves text queries and playlist URLs into playable songs.
//
// The default implementation talks to YouTube's internal "InnerTube" API (the
// same one yt-dlp and Invidious use): no API key, no quota. It is unofficial and
// can change without notice, so all of the fragile response parsing lives behind
// this package and is covered by a fixture test.
package music

import (
	"context"

	"songspot/internal/models"
)

// Provider turns a text query into playable songs. It exists so a Spotify- or
// official-YouTube-API-backed provider can be swapped in later without touching
// the HTTP handlers.
type Provider interface {
	Search(ctx context.Context, query string, limit int) ([]models.Song, error)
}
