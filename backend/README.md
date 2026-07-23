# SongSpot Backend

SongSpot is a real-time collaborative music room backend. The idea is simple:
one person creates a room, shares an invite, friends join, everyone adds songs,
and the room keeps playback state synchronized while clients play YouTube videos
locally.

This backend is the coordination layer. It does not stream audio or video. It
stores room state, manages queue mutations, issues invite links, resolves
YouTube search and playlist data, and fans out real-time room events over
WebSockets.

## Mental Model

Think of the backend as the room's control plane:

```txt
Frontend clients
  |  REST: rooms, invites, queue, search
  |  WS: play, pause, seek, realtime events
  v
Go backend
  |  Redis JSON blobs: durable-ish room/invite/cache state
  |  Redis Pub/Sub: fan-out across room clients
  v
Redis

YouTube/InnerTube
  ^  keyless search and playlist metadata
  |
Go backend
```

Every browser still embeds/controls its own YouTube player. The backend only
tells clients what should be playing, what timestamp they should sync to, and
when the backend stamped that event.

## What Exists Today

- HTTP server using Go's standard `net/http` `ServeMux`.
- Redis-backed room creation and room lookup.
- Invite creation and invite join flow.
- Queue add, get, vote, delete, batch import, and next-track routes.
- "Play now" route for immediately selecting a song.
- Keyless YouTube search through YouTube's internal InnerTube API.
- Playlist preview/import support through parsed YouTube playlist data.
- WebSocket room hubs with Redis Pub/Sub fan-out.
- Basic playback sync for `play`, `pause`, and `seek` events.
- Parser tests for the fragile YouTube response mapping code.

## What Does Not Exist Yet

- Real authentication.
- Host/admin permissions.
- Rate limiting or spam protection.
- Atomic queue/invite mutations under concurrent writes.
- Queue REST mutations broadcasting WebSocket `queue:updated` events.
- Official YouTube Data API integration.
- Full current-song metadata in room state. `currentSong` is currently just the
  YouTube video ID.

## Tech Stack

- Go `1.26.5`
- HTTP: `net/http`
- WebSocket: `github.com/gorilla/websocket`
- Redis client: `github.com/redis/go-redis/v9`
- IDs: `github.com/google/uuid`
- Env defaults: `github.com/caitlinelfring/go-env-default`
- Music lookup: custom `internal/music` package using YouTube InnerTube

## Directory Layout

```txt
backend/
  cmd/
    main.go                  # server entrypoint
  internal/
    api/
      handlers.go            # REST routes and websocket upgrade handler
    models/
      room.go                # room, song, queue models
      eventSync.go           # websocket event models
    music/
      search.go              # Provider interface
      innertube.go           # YouTube InnerTube implementation
      innertube_test.go      # parser tests
      testdata/search.json   # fixture for parser tests
    redis/
      client.go              # older Redis helper methods
    ws/
      hub.go                 # room hub and Redis Pub/Sub listener
      client.go              # websocket read/write pumps
  docker-compose.yml         # local Redis
  go.mod
  go.sum
```

## Local Development

From `backend/`, start Redis:

```sh
docker compose up -d redis
```

Run the backend:

```sh
go run ./cmd
```

Verify:

```sh
go test ./...
go vet ./...
```

Default backend URL:

```txt
http://localhost:8080
```

Default Redis address:

```txt
localhost:6380
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP server port |
| `REDIS_URL` | `localhost:6380` | Redis host and port |
| `WS_ALLOWED_ORIGINS` | empty | Comma-separated exact WebSocket origins |

When `WS_ALLOWED_ORIGINS` is empty, WebSocket origins are allowed for same-host,
`localhost`, and `127.0.0.1`. This is convenient for local development. In
production, set `WS_ALLOWED_ORIGINS` explicitly.

Example:

```sh
PORT=8080 \
REDIS_URL=localhost:6380 \
WS_ALLOWED_ORIGINS=http://localhost:5173,https://songspot.example.com \
go run ./cmd
```

## Core Data Models

### Room State

```go
type RoomState struct {
    RoomID      string `json:"roomID"`
    HostID      string `json:"hostID"`
    CurrentSong string `json:"currentSong"`
    IsPlaying   bool   `json:"isPlaying"`
    SyncTimeMs  int64  `json:"syncTimeMs"`
    UpdatedAt   int64  `json:"updatedAt"`
}
```

`UpdatedAt` is Unix milliseconds from the backend server clock. `SyncTimeMs` is
the desired playback position in the current song.

### Song

```go
type Song struct {
    ID        string `json:"id"`
    Title     string `json:"title"`
    Duration  int    `json:"duration"`
    Thumbnail string `json:"thumbnail"`
    Channel   string `json:"channel,omitempty"`
}
```

`ID` is expected to be a YouTube video ID. `Duration` is currently an integer in
seconds by convention. The backend does not enforce duration units yet.

### Room Data

```go
type RoomData struct {
    State RoomState   `json:"state"`
    Queue []QueueItem `json:"queue"`
    Users []string    `json:"users"`
}
```

Rooms are currently stored as one JSON blob in Redis:

```txt
room:{roomID}
```

That makes development simple, but it is not ideal for high-concurrency queue
updates because handlers do read-modify-write on the whole room object.

## Redis Keys

| Key | Type | Used by | Purpose |
| --- | --- | --- | --- |
| `room:{roomID}` | string JSON | REST, WebSocket sync | Main room state, queue, and users |
| `invite:{token}` | string JSON | Invite routes | Invite metadata and use count |
| `room_events:{roomID}` | Pub/Sub channel | WebSocket hub | Broadcast events to all room clients |
| `search:{limit}:{query}` | string JSON | Search route | Cached YouTube search results for 1 hour |

There are older helper methods in `internal/redis/client.go` that use more
granular keys like `room:{roomID}:queue`, `room:{roomID}:state`, and
`song:{youtubeID}`. The current REST routes mostly use `room:{roomID}` JSON
instead.

## REST API

### Health

```txt
GET /health
```

Response:

```json
{"status":"ok"}
```

### Create Room

```txt
POST /rooms
```

Request:

```json
{
  "hostID": "host_123"
}
```

Response: `201 Created`

```json
{
  "state": {
    "roomID": "room_abcd1234",
    "hostID": "host_123",
    "currentSong": "",
    "isPlaying": false,
    "syncTimeMs": 1720000000000,
    "updatedAt": 1720000000000
  },
  "queue": [],
  "users": ["host_123"]
}
```

The frontend should store `roomID` and the chosen `hostID`.

### Get Room

```txt
GET /rooms/{roomID}
```

Returns the full `RoomData` object.

### Create Invite

```txt
POST /rooms/{roomID}/invites
```

Request body is optional:

```json
{
  "maxUses": 5,
  "validHours": 24
}
```

Defaults:

- `maxUses`: `5`
- `validHours`: `24`

Response:

```json
{
  "token": "uuid-token",
  "expiresAt": "2026-07-23T12:00:00Z",
  "maxUses": 5
}
```

The frontend can turn this token into an app URL like `/join/{token}`.

### Join Invite

```txt
POST /invites/{token}/join
```

Response:

```json
{
  "roomId": "room_abcd1234",
  "userId": "user_a1b2c3"
}
```

The frontend should store the returned `userId` and use it for the WebSocket
connection.

### Search YouTube

```txt
GET /search?q={query}&limit={limit}
```

Rules:

- `q` is required.
- `limit` is optional.
- default `limit` is `15`.
- max accepted `limit` is `50`.
- successful responses are cached in Redis for 1 hour.

Response:

```json
[
  {
    "id": "dQw4w9WgXcQ",
    "title": "Rick Astley - Never Gonna Give You Up",
    "duration": 213,
    "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    "channel": "Rick Astley"
  }
]
```

### Preview Playlist

```txt
GET /playlist?url={youtubePlaylistUrlOrId}
```

Response:

```json
{
  "songs": [
    {
      "id": "youtubeVideoId",
      "title": "Song title",
      "duration": 240,
      "thumbnail": "https://...",
      "channel": "Uploader"
    }
  ]
}
```

This route previews playlist contents only. It does not mutate any room.

### Get Queue

```txt
GET /rooms/{roomID}/queue
```

Returns:

```json
[
  {
    "song": {
      "id": "youtubeVideoId",
      "title": "Song title",
      "duration": 240,
      "thumbnail": "https://...",
      "channel": "Uploader"
    },
    "votes": 0
  }
]
```

### Add Song To Queue

```txt
POST /rooms/{roomID}/queue
```

Request:

```json
{
  "id": "youtubeVideoId",
  "title": "Song title",
  "duration": 240,
  "thumbnail": "https://...",
  "channel": "Uploader"
}
```

Response: updated queue.

### Add Songs In Batch

```txt
POST /rooms/{roomID}/queue/batch
```

Request:

```json
{
  "songs": [
    {
      "id": "youtubeVideoId",
      "title": "Song title",
      "duration": 240,
      "thumbnail": "https://..."
    }
  ]
}
```

This route is meant for playlist import. It avoids sending one HTTP request per
song.

Response: updated queue.

### Vote Song

```txt
POST /rooms/{roomID}/queue/{songID}/vote
```

The backend increments that queue item's vote count and sorts the queue by
highest votes first.

Response: updated queue.

### Delete Song From Queue

```txt
DELETE /rooms/{roomID}/queue/{songID}
```

Response: updated queue.

### Advance Queue

```txt
POST /rooms/{roomID}/queue/next
```

The first queue item becomes the current song:

- `state.currentSong` becomes the first song ID.
- `state.isPlaying` becomes `true`.
- `state.syncTimeMs` becomes `0`.
- the first item is removed from the queue.

Response: updated `RoomState`.

### Play Song Immediately

```txt
POST /rooms/{roomID}/play
```

Request:

```json
{
  "song": {
    "id": "youtubeVideoId",
    "title": "Song title",
    "duration": 240,
    "thumbnail": "https://..."
  }
}
```

The backend currently stores only `song.id` in `state.currentSong`, sets
`isPlaying` to `true`, resets `syncTimeMs` to `0`, and updates `updatedAt`.

Response: updated `RoomState`.

## WebSocket API

Connect:

```txt
GET /ws?roomID={roomID}&userID={userID}
```

Browser example:

```js
const ws = new WebSocket(
  `ws://localhost:8080/ws?roomID=${roomID}&userID=${userID}`
);
```

The backend creates one in-memory hub per room. Each hub subscribes to:

```txt
room_events:{roomID}
```

Messages sent by one client are published to Redis, then Redis Pub/Sub feeds
them back into the room hub, and the hub writes the event to every connected
client in that room.

### Event Envelope

```json
{
  "action": "play",
  "data": {},
  "timestamp": 1720000000000
}
```

### Ping/Pong Time Sync

Client sends:

```json
{
  "action": "ping",
  "data": {
    "clientTime": 1720000000000
  },
  "timestamp": 0
}
```

Backend responds only to that client:

```json
{
  "action": "pong",
  "data": {
    "clientTime": 1720000000000,
    "serverTime": 1720000000050
  },
  "timestamp": 1720000000050
}
```

The frontend can use this to estimate client-server clock offset. That offset
is what lets clients schedule playback more precisely than "do it whenever the
message arrives".

### Playback Sync Events

The backend treats these actions specially:

- `play`
- `pause`
- `seek`

Example:

```json
{
  "action": "play",
  "data": {
    "syncTimeMs": 15000
  },
  "timestamp": 0
}
```

For `play`, `pause`, and `seek`, the backend:

1. Validates that `data.syncTimeMs` exists.
2. Fetches `room:{roomID}` from Redis.
3. Updates `room.state.isPlaying`.
4. Updates `room.state.syncTimeMs`.
5. Updates `room.state.updatedAt`.
6. Saves the room state back to Redis.
7. Stamps the outbound event with backend server time.
8. Publishes the enriched event to `room_events:{roomID}`.

Current behavior:

- `play` sets `isPlaying = true`.
- `pause` sets `isPlaying = false`.
- `seek` also sets `isPlaying = false` because the current logic only checks
  whether the action is exactly `play`.

If the frontend wants seek to preserve playback state, extend the payload:

```json
{
  "action": "seek",
  "data": {
    "syncTimeMs": 42000,
    "isPlaying": true
  }
}
```

Then update the backend to use `data.isPlaying`.

### Pass-Through Events

Any non-`ping` and non-playback-sync event is published unchanged:

```json
{
  "action": "chat",
  "data": {
    "message": "hello"
  },
  "timestamp": 0
}
```

There is no schema validation for arbitrary custom actions yet.

## How InnerTube Search Works

`internal/music` hides the fragile YouTube parsing from the HTTP handlers.

The `Provider` interface starts small:

```go
type Provider interface {
    Search(ctx context.Context, query string, limit int) ([]models.Song, error)
}
```

`InnerTube` is the current implementation. It calls YouTube's internal web
client API:

```txt
https://www.youtube.com/youtubei/v1
```

The key in `innertube.go` is a public web client key embedded in YouTube's own
frontend. It is not a private API secret. This avoids needing a YouTube Data API
key during development, but it is unofficial and can break if YouTube changes
its response structure.

For search, the backend:

1. Sends an InnerTube `/search` request.
2. Walks the nested response tree looking for `videoRenderer` nodes.
3. Extracts video ID, title, duration, thumbnail, and channel.
4. Deduplicates repeated videos.
5. Returns `[]models.Song`.

For playlists, the backend:

1. Fetches the YouTube playlist page HTML.
2. Extracts the embedded `ytInitialData` JSON blob.
3. Walks that tree for playlist video components.
4. Follows continuation tokens through the InnerTube `/browse` endpoint.
5. Caps playlist extraction at `300` songs.

Parser tests use fixture data in `internal/music/testdata/search.json` so the
most brittle response-walking logic has some coverage.

## Frontend Integration Flow

Recommended happy path:

1. Create room with `POST /rooms`.
2. Store returned `roomID` and `hostID`.
3. Create invite with `POST /rooms/{roomID}/invites`.
4. Friend opens frontend invite URL.
5. Frontend calls `POST /invites/{token}/join`.
6. Store returned `roomId` and `userId`.
7. Connect WebSocket with `/ws?roomID={roomId}&userID={userId}`.
8. Fetch room with `GET /rooms/{roomID}`.
9. Search songs with `GET /search?q=...`.
10. Add selected songs with `POST /rooms/{roomID}/queue`.
11. Optionally import playlists with `GET /playlist` and `POST /queue/batch`.
12. Control playback through WebSocket `play`, `pause`, and `seek`.

## Engineering Notes

### Why Redis?

Redis is doing two jobs:

1. State storage for rooms, invites, and cached search results.
2. Pub/Sub transport for WebSocket fan-out.

This means the app can eventually run more than one Go process. Each process can
host local WebSocket clients, publish messages to Redis, and receive messages
from Redis for the rooms it has active.

### Why WebSockets and Not Polling?

Playback controls need low-latency fan-out. Polling would be sluggish and waste
requests. WebSockets let the room keep a live control channel open.

### Why Not Stream Audio From The Backend?

The backend should not proxy YouTube audio/video. Clients embed/control YouTube
locally, while the backend coordinates state. This keeps bandwidth low and keeps
the product focused on synchronization rather than media delivery.

### Why InnerTube?

Official YouTube Data API needs an API key and quota management. InnerTube is
keyless from the app's point of view and good for prototyping search/playlist
metadata. The tradeoff is fragility: it is unofficial.

## Current Risks And TODOs

- Add host/admin checks for:
  - deleting songs
  - advancing queue
  - play-now
  - playback sync events
- Add rate limiting for spammy actions:
  - `play`
  - `pause`
  - `seek`
  - `queue/next`
  - votes
- Broadcast queue changes over WebSocket.
- Store full current song metadata, not just the current song ID.
- Make queue and invite mutations atomic in Redis.
- Validate song payloads more strictly.
- Preserve `isPlaying` during seek when frontend sends that intent.
- Add CORS handling if the frontend runs on a different origin for REST calls.
- Decide whether InnerTube is acceptable long term or whether to move to the
  official YouTube Data API.

## Useful Commands

```sh
# Start Redis
docker compose up -d redis

# Run backend
go run ./cmd

# Test everything
go test ./...

# Static checks
go vet ./...

# Hit health endpoint
curl http://localhost:8080/health

# Search songs
curl "http://localhost:8080/search?q=daft%20punk&limit=5"
```

