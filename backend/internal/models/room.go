package models

import "time"

// RoomTTL bounds how long an idle room lingers in Redis. Every write refreshes
// it, so a room in use never expires; an abandoned one is reclaimed a day later
// instead of accumulating forever. Always pass this when writing a room key —
// writing with no expiry would clear the TTL and make the room permanent.
const RoomTTL = 24 * time.Hour

type RoomState struct {
	RoomID      string `json:"roomID"`
	HostID      string `json:"hostID"`
	CurrentSong string `json:"currentSong"`
	IsPlaying   bool   `json:"isPlaying"`
	SyncTimeMs  int64  `json:"syncTimeMs"`
	UpdatedAt   int64  `json:"updatedAt"`
	// EveryoneControls lets any participant drive playback (play/pause/seek/next
	// and play-now). When false (default), only the host can. Everyone can
	// always add songs and vote regardless.
	EveryoneControls bool `json:"everyoneControls"`
}

type Song struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Duration  int    `json:"duration"`
	Thumbnail string `json:"thumbnail"`
	// Channel is the uploader, shown to disambiguate search results (e.g.
	// official vs. cover). Optional — omitted for songs added by raw link.
	Channel string `json:"channel,omitempty"`
}

type QueueItem struct {
	Song Song `json:"song"`
	// Votes is the count, kept equal to len(Voters) so existing clients keep
	// working. Voters holds the ids of who voted, to enforce one vote per user
	// (and let the UI show/toggle a user's own vote).
	Votes  int      `json:"votes"`
	Voters []string `json:"voters"`
}

type RoomData struct {
	State RoomState   `json:"state"`
	Queue []QueueItem `json:"queue"`
	Users []string    `json:"users"`
}
