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
- Short, speakable room codes (`K4M9TQ`) that double as the join credential.
- Redis-backed room creation, lookup, and join-by-code.
- Queue add, get, vote, delete, batch import, and next-track routes.
- "Play now" route for immediately selecting a song.
- Host-only playback control, with a switch to open it to everyone.
- Keyless YouTube search through YouTube's internal InnerTube API.
- Playlist preview/import support through parsed YouTube playlist data.
- WebSocket room hubs with Redis Pub/Sub fan-out, started on the first listener
  and torn down after the last one leaves.
- Playback sync for `play`, `pause`, and `seek` events.
- Server-side broadcasts of queue and state changes after REST mutations.
- Full current-song metadata in room state, so late joiners can name what's on.
- Invite tokens, kept working for links shared before room codes existed.
- Parser tests for the fragile YouTube response mapping code, plus room-code and
  playhead tests.

## What Does Not Exist Yet

- Real authentication. Anyone with a room code can join and mutate the queue.
- Rate limiting or spam protection.
- Atomic queue/invite mutations under concurrent writes. Handlers still do
  read-modify-write on the whole room blob.
- Official YouTube Data API integration.
- Presence that spans more than one server instance.

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
      room.go                # room, song, queue models + playhead maths
      roomcode.go            # room code generation and normalisation
      roomcode_test.go       # code + playhead tests
      eventSync.go           # websocket event models
    music/
      search.go              # Provider interface
      innertube.go           # YouTube InnerTube implementation
      innertube_test.go      # parser tests
      testdata/search.json   # fixture for parser tests
    ws/
      hub.go                 # hub registry, room hub, Redis Pub/Sub listener
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
    RoomID           string `json:"roomID"`
    HostID           string `json:"hostID"`
    CurrentSong      string `json:"currentSong"`
    NowPlaying       *Song  `json:"nowPlaying,omitempty"`
    IsPlaying        bool   `json:"isPlaying"`
    SyncTimeMs       int64  `json:"syncTimeMs"`
    UpdatedAt        int64  `json:"updatedAt"`
    EveryoneControls bool   `json:"everyoneControls"`
}
```

`UpdatedAt` is Unix milliseconds from the backend server clock. `SyncTimeMs` is
the playback position within the current song *as of `UpdatedAt`* — the two are
an anchor pair, not independent values. A room that is still playing has moved
on since, which is what `RoomState.PlayheadMs` works out. Changing one without
the other makes every listener's playhead jump.

`NowPlaying` carries the full metadata for `CurrentSong`. Songs leave the queue
when they start playing, so without it a listener who arrived mid-song has no
way to name what they're hearing.

`EveryoneControls` opens playback to all participants. When false (the default)
only the host can play, pause, seek, skip, remove songs, or play-now. Everyone
can always add songs and vote.

### Room Codes

Room ids are six characters from `23456789BCDFGHJKMNPQRSTVWXZ` — no `0`/`O`, no
`1`/`I`/`L`, and no vowels, so a code can be read down a phone line and can't
accidentally spell a word. Codes are claimed with `SETNX`, so two rooms created
at the same instant can't collide.

Ids are normalised on the way in (`models.NormalizeRoomID`): case-insensitive,
and spaces/dashes are stripped, so `k4m 9tq` and `K4M-9TQ` both reach `K4M9TQ`.
Rooms created before short codes have uuid-derived ids like `room_a1b2c3d4`;
those still resolve.

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

Room keys carry a 24-hour TTL that every write refreshes, so a room in use never
expires and an abandoned one is reclaimed rather than kept forever. Always pass
`models.RoomTTL` when writing a room key — writing with no expiry clears the TTL
and makes the room permanent.

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
    "roomID": "K4M9TQ",
    "hostID": "host_123",
    "currentSong": "",
    "isPlaying": false,
    "syncTimeMs": 0,
    "updatedAt": 1720000000000,
    "everyoneControls": false
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

### Join By Room Code

```txt
POST /rooms/{roomID}/join
```

The main way into a room. Confirms the room exists before a client opens a
socket, and adds the caller to the roster.

Request body is optional:

```json
{
  "userID": "user_a1b2c3"
}
```

Pass a `userID` you already hold to keep the same identity — and therefore the
same votes, and the host's control — across a refresh. Omit it to be assigned a
fresh one.

Response: `200 OK`

```json
{
  "roomId": "K4M9TQ",
  "userId": "user_a1b2c3"
}
```

`roomId` is the canonical form of the code, which may differ from what was sent
(`k4m 9tq` in, `K4M9TQ` out).

### Create Invite

Invite tokens predate room codes and are no longer how the UI shares a room.
They stay so links handed out earlier keep working.

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

Request body is optional:

```json
{
  "userID": "user_a1b2c3",
  "afterSongID": "currentYoutubeVideoId"
}
```

The first queue item becomes the current song:

- `state.currentSong` and `state.nowPlaying` become the first song.
- `state.isPlaying` becomes `true`.
- `state.syncTimeMs` becomes `0`.
- the first item is removed from the queue.

`afterSongID` names the song the caller believes is playing, and is what makes
automatic end-of-song advancing safe. Two things follow from setting it:

1. The call only advances if that song is still current. So every client in the
   room can fire it the moment a track ends, and the queue still moves exactly
   one step — the first wins and the rest get back the settled state.
2. A track that has genuinely run past its own duration may be advanced by any
   listener, even in a host-only room. Without this a room whose host closed
   their tab would sit on a finished song forever. Songs with an unknown
   duration can't be proven finished, so they stay host-only.

Manual skips (no `afterSongID`) always require playback permission.

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
- `seek` leaves `isPlaying` alone, so dragging the scrubber doesn't stop the
  room. (It used to pause it, because the logic only asked whether the action
  was exactly `play`.)

Events from a non-host are dropped unless `everyoneControls` is set.

### Server-Sent Room Events

The backend publishes these after REST mutations, so listeners neither poll nor
depend on the mutating client to announce its own change over its socket:

| Action | Data | Sent after |
| --- | --- | --- |
| `queue:updated` | `{"queue": [...]}` | add, batch, vote, delete, next |
| `state:updated` | `{"state": {...}}` | next, play-now, control toggle |
| `presence` | `{"count": 3}` | anyone joining or leaving the socket |
| `kicked` | `{"userID": "user_x"}` | the host removing a participant |

Each event carries the new value rather than a bare "something changed" nudge,
so a vote in a room of ten doesn't turn into ten refetches. `presence` counts
live sockets deduped by user, so one person's two tabs count once.

### Pass-Through Events

Any other event is published to the room unchanged. There is no schema
validation for custom actions yet.

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

1. Create room with `POST /rooms`. Store the returned `roomID` (the code) and
   the `hostID` you chose.
2. Share the code, or a link carrying it — the frontend uses `/r/{code}`.
3. A friend opens that link; the frontend calls `POST /rooms/{code}/join`,
   passing any `userID` it already has for this room.
4. Store the returned `roomId` and `userId`.
5. Connect WebSocket with `/ws?roomID={roomId}&userID={userId}`.
6. Fetch room with `GET /rooms/{roomID}` — the response already contains the
   queue, so there's no need to also call `/queue`.
7. Search songs with `GET /search?q=...`.
8. Add selected songs with `POST /rooms/{roomID}/queue`.
9. Optionally import playlists with `GET /playlist` and `POST /queue/batch`.
10. Control playback through WebSocket `play`, `pause`, and `seek`.
11. Apply `queue:updated` and `state:updated` as they arrive rather than
    refetching — they carry the new value.

On reconnect, refetch the room and realign the playhead: events that fired while
the socket was down are not replayed.

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

- Add rate limiting for spammy actions: `play`, `pause`, `seek`, `queue/next`,
  and votes.
- Make queue and invite mutations atomic in Redis. Everything is still a
  read-modify-write of the whole room blob, so two simultaneous writers can lose
  one another's change. Invite `uses` has the same problem, which means a
  max-uses limit can be exceeded under a concurrent rush.
- Validate song payloads more strictly (only the id is required today).
- Presence only counts sockets on the current instance. Running more than one
  server would need the count to go through Redis too.
- Decide whether InnerTube is acceptable long term or whether to move to the
  official YouTube Data API.
- There is still no authentication of any kind. `userID` is self-asserted, so
  the host-only checks keep honest people honest and nothing more.

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

