package models

import (
	"strings"
	"testing"
)

func TestNewRoomCodeShape(t *testing.T) {
	for range 500 {
		code, err := NewRoomCode()
		if err != nil {
			t.Fatalf("NewRoomCode: %v", err)
		}
		if !IsRoomCode(code) {
			t.Fatalf("NewRoomCode produced %q, which IsRoomCode rejects", code)
		}
		// The whole point of the alphabet is that a code can be read aloud, so
		// guard the exclusions rather than just the length.
		if strings.ContainsAny(code, "01OIL") {
			t.Fatalf("code %q contains a lookalike character", code)
		}
	}
}

func TestNewRoomCodeUsesWholeAlphabet(t *testing.T) {
	// Rejection sampling exists so the first 13 letters aren't favoured; a
	// biased generator would leave the tail of the alphabet unused here.
	seen := map[rune]bool{}
	for range 2000 {
		code, err := NewRoomCode()
		if err != nil {
			t.Fatalf("NewRoomCode: %v", err)
		}
		for _, r := range code {
			seen[r] = true
		}
	}
	if len(seen) != len(RoomCodeAlphabet) {
		t.Errorf("only %d of %d alphabet characters ever appeared", len(seen), len(RoomCodeAlphabet))
	}
}

func TestNormalizeRoomID(t *testing.T) {
	cases := []struct{ in, want string }{
		{"K4M9TQ", "K4M9TQ"},
		{"k4m9tq", "K4M9TQ"},
		{"  k4m9tq  ", "K4M9TQ"},
		{"K4M 9TQ", "K4M9TQ"}, // read aloud, typed with a pause
		{"k4m-9tq", "K4M9TQ"}, // pasted from a hyphenated write-up
		{"K4M_9TQ", "K4M9TQ"},
		// Rooms created before short codes keep their uuid-derived ids, and the
		// underscore in the prefix must survive normalisation.
		{"room_a1b2c3d4", "room_a1b2c3d4"},
		{"ROOM_A1B2C3D4", "room_a1b2c3d4"},
		{"", ""},
	}
	for _, c := range cases {
		if got := NormalizeRoomID(c.in); got != c.want {
			t.Errorf("NormalizeRoomID(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsRoomCodeRejectsJunk(t *testing.T) {
	for _, bad := range []string{"", "K4M9T", "K4M9TQQ", "K4M9TO", "k4m9tq", "room_a1b2c3d4"} {
		if IsRoomCode(bad) {
			t.Errorf("IsRoomCode(%q) = true, want false", bad)
		}
	}
}
