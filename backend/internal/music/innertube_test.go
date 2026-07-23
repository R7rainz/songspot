package music

import (
	"encoding/json"
	"os"
	"testing"
)

func TestExtractSongs(t *testing.T) {
	raw, err := os.ReadFile("testdata/search.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}

	songs := extractSongs(root, "videoRenderer", 15)

	if len(songs) != 2 {
		t.Fatalf("expected 2 songs (ad skipped, duplicate dropped), got %d", len(songs))
	}

	first := songs[0]
	if first.ID != "dQw4w9WgXcQ" {
		t.Errorf("id: got %q", first.ID)
	}
	if first.Title != "Rick Astley - Never Gonna Give You Up" {
		t.Errorf("title: got %q", first.Title)
	}
	if first.Duration != 213 {
		t.Errorf("duration: want 213, got %d", first.Duration)
	}
	if first.Channel != "Rick Astley" {
		t.Errorf("channel: got %q", first.Channel)
	}
	if first.Thumbnail != "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" {
		t.Errorf("thumbnail: got %q", first.Thumbnail)
	}

	// Live stream: no lengthText -> duration 0, protocol-relative thumb fixed up.
	second := songs[1]
	if second.Duration != 0 {
		t.Errorf("live duration: want 0, got %d", second.Duration)
	}
	if second.Thumbnail != "https://i.ytimg.com/vi/5qap5aO4i9A/hqdefault.jpg" {
		t.Errorf("live thumbnail: got %q", second.Thumbnail)
	}
}

func TestExtractSongsLimit(t *testing.T) {
	raw, _ := os.ReadFile("testdata/search.json")
	var root any
	_ = json.Unmarshal(raw, &root)

	if got := len(extractSongs(root, "videoRenderer", 1)); got != 1 {
		t.Fatalf("limit 1: got %d songs", got)
	}
}

func TestParseDuration(t *testing.T) {
	cases := map[string]int{
		"":        0,
		"0:59":    59,
		"3:33":    213,
		"1:02:03": 3723,
		"garbage": 0,
	}
	for in, want := range cases {
		if got := parseDuration(in); got != want {
			t.Errorf("parseDuration(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParsePlaylistID(t *testing.T) {
	cases := map[string]string{
		"https://www.youtube.com/playlist?list=PLabc123":            "PLabc123",
		"https://www.youtube.com/watch?v=xyz&list=PLdef456&index=2": "PLdef456",
		"PLbare789": "PLbare789",
		"https://www.youtube.com/watch?v=noListHere": "",
		"": "",
	}
	for in, want := range cases {
		if got := ParsePlaylistID(in); got != want {
			t.Errorf("ParsePlaylistID(%q) = %q, want %q", in, got, want)
		}
	}
}
