package models

type WSEvent struct {
	Action    string      `json:"action"`
	Data      interface{} `json:"data"`
	Timestamp int64       `json:"timestamp"`
}

type PlaybackUpdateData struct {
	IsPlaying  bool   `json:"isPlaying"`
	PositionMs int64  `json:"positionMs"`
	SongID     string `json:"songId"`
	SourceUser string `json:"sourceUser"`
}

type TimeSyncData struct {
	ClientTime int64 `json:"clientTime"`
	ServerTime int64 `json:"serverTime"`
}
