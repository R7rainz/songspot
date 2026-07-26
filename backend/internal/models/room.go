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
	// NowPlaying is the full metadata for CurrentSong. Songs leave the queue
	// when they start playing, so without this a listener who joined mid-song
	// has no way to name what they're hearing.
	NowPlaying *Song `json:"nowPlaying,omitempty"`
	IsPlaying  bool  `json:"isPlaying"`
	SyncTimeMs int64 `json:"syncTimeMs"`
	UpdatedAt  int64 `json:"updatedAt"`
	// EveryoneControls lets any participant drive playback (play/pause/seek/next
	// and play-now). When false (default), only the host can. Everyone can
	// always add songs and vote regardless.
	EveryoneControls bool `json:"everyoneControls"`
}

// PlayheadMs estimates where the current song is right now, in milliseconds.
// SyncTimeMs is only an anchor — it records where the song was at UpdatedAt —
// so a room that is still playing has moved on since.
func (s RoomState) PlayheadMs(nowMs int64) int64 {
	if !s.IsPlaying {
		return s.SyncTimeMs
	}
	return s.SyncTimeMs + (nowMs - s.UpdatedAt)
}

// CurrentSongFinished reports whether the current track has run past its own
// length. This is what lets any listener advance a room whose host has closed
// their tab, without handing everyone a general-purpose skip button.
func (s RoomState) CurrentSongFinished(nowMs int64) bool {
	if s.NowPlaying == nil || s.NowPlaying.Duration <= 0 {
		return false
	}
	// A few seconds of slack: clients report "ended" from their own player,
	// which can fire slightly before this arithmetic agrees.
	return s.PlayheadMs(nowMs) >= int64(s.NowPlaying.Duration)*1000-3000
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
