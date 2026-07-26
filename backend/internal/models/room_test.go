package models

import (
	"testing"
	"time"
)

func TestPlayheadMs(t *testing.T) {
	now := time.Now().UnixMilli()

	// Paused: the anchor is the answer, however long ago it was set.
	paused := RoomState{SyncTimeMs: 30_000, UpdatedAt: now - 120_000, IsPlaying: false}
	if got := paused.PlayheadMs(now); got != 30_000 {
		t.Errorf("paused playhead = %d, want 30000", got)
	}

	// Playing: the song has moved on since the anchor was set.
	playing := RoomState{SyncTimeMs: 30_000, UpdatedAt: now - 5_000, IsPlaying: true}
	if got := playing.PlayheadMs(now); got != 35_000 {
		t.Errorf("playing playhead = %d, want 35000", got)
	}
}

func TestCurrentSongFinished(t *testing.T) {
	now := time.Now().UnixMilli()
	song := &Song{ID: "abc", Duration: 200} // 200s

	// Paused 10s in: nowhere near the end.
	paused := RoomState{NowPlaying: song, SyncTimeMs: 10_000, UpdatedAt: now, IsPlaying: false}
	if paused.CurrentSongFinished(now) {
		t.Error("a paused song 10s in should not count as finished")
	}

	// Playing, anchored at 0 but three and a half minutes have passed since.
	playing := RoomState{NowPlaying: song, SyncTimeMs: 0, UpdatedAt: now - 210_000, IsPlaying: true}
	if !playing.CurrentSongFinished(now) {
		t.Error("a 200s song playing for 210s should count as finished")
	}

	// Songs added by raw link have no duration, so we can never prove they
	// ended — those must stay host-only to advance.
	unknown := RoomState{NowPlaying: &Song{ID: "abc"}, UpdatedAt: now - 600_000, IsPlaying: true}
	if unknown.CurrentSongFinished(now) {
		t.Error("a song with unknown duration must never report finished")
	}

	// Rooms saved before NowPlaying existed have no metadata at all.
	if (RoomState{}).CurrentSongFinished(now) {
		t.Error("an empty state must never report finished")
	}
}
