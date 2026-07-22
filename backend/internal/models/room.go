package models

type RoomState struct {
	RoomID      string `json:"roomID"`
	HostID      string `json:"hostID"`
	CurrentSong string `json:"currentSong"`
	IsPlaying   bool   `json:"isPlaying"`
	SyncTimeMs  int64  `json:"syncTimeMs"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type Song struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Duration  int    `json:"duration"`
	Thumbnail string `json:"thumbnail"`
}

type QueueItem struct {
	Song  Song `json:"song"`
	Votes int  `json:"votes"`
}

type RoomData struct {
	State RoomState   `json:"state"`
	Queue []QueueItem `json:"queue"`
	Users []string    `json:"users"`
}
