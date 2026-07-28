package models

import "time"

type InviteToken struct {
	RoomID    string    `json:"roomID"`
	ExpiresAt time.Time `json:"expiresAt"`
	MaxUses   int       `json:"maxUses"`
	Uses      int       `json:"uses"`
}
