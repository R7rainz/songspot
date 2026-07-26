package models

import (
	"crypto/rand"
	"strings"
)

// RoomCodeAlphabet is what room codes are made of. It leaves out anything that
// gets misread when a code is spoken aloud or typed from a screenshot: the
// 0/O and 1/I/L lookalikes, and every vowel — dropping vowels costs a little
// keyspace but guarantees a random code can never spell a real word.
const RoomCodeAlphabet = "23456789BCDFGHJKMNPQRSTVWXZ"

// RoomCodeLength is short enough to read over a call and long enough that
// guessing a live room is impractical (27^6 ≈ 387M combinations).
const RoomCodeLength = 6

// NewRoomCode returns a random room code. Callers must still claim it with a
// conditional write — the keyspace makes collisions rare, not impossible.
func NewRoomCode() (string, error) {
	code := make([]byte, 0, RoomCodeLength)
	// Rejection sampling: taking a raw byte modulo 27 would favour the first
	// 13 letters of the alphabet, since 256 isn't a multiple of 27.
	limit := byte(256 / len(RoomCodeAlphabet) * len(RoomCodeAlphabet))
	buf := make([]byte, RoomCodeLength)
	for len(code) < RoomCodeLength {
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		for _, b := range buf {
			if b >= limit {
				continue
			}
			code = append(code, RoomCodeAlphabet[int(b)%len(RoomCodeAlphabet)])
			if len(code) == RoomCodeLength {
				break
			}
		}
	}
	return string(code), nil
}

// IsRoomCode reports whether s is a well-formed short room code.
func IsRoomCode(s string) bool {
	if len(s) != RoomCodeLength {
		return false
	}
	for _, r := range s {
		if !strings.ContainsRune(RoomCodeAlphabet, r) {
			return false
		}
	}
	return true
}

// NormalizeRoomID canonicalises whatever a user typed or a URL carried, so
// "k4m 9tq", "K4M-9TQ" and "K4M9TQ" all reach the same room. Rooms created
// before short codes existed have uuid-derived ids like "room_a1b2c3d4"; those
// are lower-cased and otherwise left alone so old links keep resolving.
func NormalizeRoomID(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(trimmed), "room_") {
		return strings.ToLower(trimmed)
	}

	var b strings.Builder
	b.Grow(len(trimmed))
	for _, r := range trimmed {
		if r == ' ' || r == '-' || r == '_' {
			continue
		}
		b.WriteRune(r)
	}
	return strings.ToUpper(b.String())
}
