# SongSpot Backend Agent Notes

This document is a handoff for agents building against the SongSpot backend,
especially a frontend agent. It describes the current backend behavior, API
contracts, WebSocket events, Redis assumptions, and known gaps.

## Project Purpose

SongSpot is a collaborative listening app. Users create rooms, invite friends,
add YouTube songs to a shared queue, vote on songs, and keep playback state in
sync across room participants.

The backend currently provides:

- Room creation and lookup.
- Invite creation and join flow.
- Queue add/get/vote/delete/next routes.
- WebSocket room broadcasting through Redis Pub/Sub.
- Basic playback sync events for `play`, `pause`, and `seek`.

The backend does not yet provide:

- YouTube Search/Data API integration.
- Authentication or real user accounts.
- Host-only/admin permission checks.
- WebSocket broadcasts for REST queue changes.
- Atomic Redis updates for concurrent queue/invite writes.

## Tech Stack

- Language: Go
- HTTP router: standard library `net/http` `ServeMux`
- WebSocket: `github.com/gorilla/websocket`
- Redis client: `github.com/redis/go-redis/v9`
- IDs: `github.com/google/uuid`
- Env defaults: `github.com/caitlinelfring/go-env-default`

## Local Setup

Start Redis from the backend directory:

```sh
docker compose up -d redis
```

Run the backend:

```sh
go run ./cmd
```

Default server URL:

```txt
http://localhost:8080
```

Default Redis URL:

```txt
localhost:6380
```

Useful checks:

```sh
go test ./...
go vet ./...
```

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP server port |
| `REDIS_URL` | `localhost:6380` | Redis address |
| `WS_ALLOWED_ORIGINS` | empty | Comma-separated exact WebSocket origins allowed in production |

When `WS_ALLOWED_ORIGINS` is empty, WebSocket origin checking allows same-origin,
`localhost`, and `127.0.0.1` for local development.

## Data Models

### `RoomData`

```json
{
  "state": {
    "roomID": "room_abcd1234",
    "hostID": "host_123",
    "currentSong": "youtubeVideoId",
    "isPlaying": false,
    "syncTimeMs": 0,
    "updatedAt": 1720000000000
  },
  "queue": [
    {
      "song": {
        "id": "youtubeVideoId",
        "title": "Song title",
        "duration": 240,
        "thumbnail": "https://..."
      },
      "votes": 0
    }
  ],
  "users": ["host_123", "user_abc123"]
}
```

### `Song`

Frontend should send this shape when adding a song to the queue:

```json
{
  "id": "youtubeVideoId",
  "title": "Song title",
  "duration": 240,
  "thumbnail": "https://..."
}
```

`duration` is currently an integer. Keep it consistent with the frontend. A
practical choice is seconds, but the backend does not enforce units yet.

### `WSEvent`

```json
{
  "action": "play",
  "data": {},
  "timestamp": 1720000000000
}
```

`timestamp` is set by the backend for playback sync events before broadcasting.

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

Frontend should persist `roomID` and `hostID`.

### Get Room

```txt
GET /rooms/{roomID}
```

Response: `200 OK`

Returns `RoomData`.

### Create Invite

```txt
POST /rooms/{roomID}/invites
```

Request body is optional. Defaults are `maxUses: 5` and `validHours: 24`.

```json
{
  "maxUses": 5,
  "validHours": 24
}
```

Response: `201 Created`

```json
{
  "token": "uuid-token",
  "expiresAt": "2026-07-23T12:00:00Z",
  "maxUses": 5
}
```

Frontend can build invite links like:

```txt
/join/{token}
```

Then call the backend join endpoint.

### Join Invite

```txt
POST /invites/{token}/join
```

Response: `200 OK`

```json
{
  "roomId": "room_abcd1234",
  "userId": "user_a1b2c3"
}
```

Frontend should persist `userId` and connect WebSocket using the returned
`roomId` and `userId`.

### Get Queue

```txt
GET /rooms/{roomID}/queue
```

Response: `200 OK`

```json
[
  {
    "song": {
      "id": "youtubeVideoId",
      "title": "Song title",
      "duration": 240,
      "thumbnail": "https://..."
    },
    "votes": 1
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
  "thumbnail": "https://..."
}
```

Response: `200 OK`

Returns the updated queue.

### Vote Song

```txt
POST /rooms/{roomID}/queue/{songID}/vote
```

Response: `200 OK`

Returns the updated queue, sorted by highest votes first.

### Delete Song From Queue

```txt
DELETE /rooms/{roomID}/queue/{songID}
```

Response: `200 OK`

Returns the updated queue.

### Advance Queue

```txt
POST /rooms/{roomID}/queue/next
```

Response: `200 OK`

Returns updated room state. The first queued song becomes `currentSong`,
`isPlaying` becomes `true`, and the song is removed from the queue.

## WebSocket API

Connect:

```txt
GET /ws?roomID={roomID}&userID={userID}
```

Example browser URL:

```js
const ws = new WebSocket(
  `ws://localhost:8080/ws?roomID=${roomID}&userID=${userID}`
);
```

The backend creates one in-memory hub per room and uses Redis Pub/Sub channel:

```txt
room_events:{roomID}
```

### Time Sync Ping

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

Backend responds only to that same client:

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

Frontend can use this to estimate client/server clock offset.

### Playback Sync Events

The backend currently treats these actions specially:

- `play`
- `pause`
- `seek`

Client sends:

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

1. Reads `data.syncTimeMs`.
2. Fetches `room:{roomID}` from Redis.
3. Updates `room.state.isPlaying`.
4. Updates `room.state.syncTimeMs`.
5. Updates `room.state.updatedAt`.
6. Saves the room back to Redis.
7. Stamps the event with backend server time.
8. Publishes the event to all room clients.

Current behavior:

- `play` sets `isPlaying` to `true`.
- `pause` sets `isPlaying` to `false`.
- `seek` currently sets `isPlaying` to `false` because the backend only checks
  whether the action equals `play`.

Frontend note: if seek should preserve playback state, the backend should be
extended to accept `data.isPlaying`.

### Other WebSocket Events

Any non-`ping` and non-playback-sync event is passed through unchanged:

```json
{
  "action": "chat",
  "data": {
    "message": "hello"
  },
  "timestamp": 0
}
```

The backend does not validate custom actions yet.

## Redis Keys

Current active keys:

| Key | Type | Purpose |
| --- | --- | --- |
| `room:{roomID}` | string JSON | Full `RoomData` blob used by REST and playback sync |
| `invite:{token}` | string JSON | REST invite token data |
| `room_events:{roomID}` | Pub/Sub | WebSocket event fan-out |

Older helper methods in `internal/redis/client.go` also reference:

| Key | Purpose |
| --- | --- |
| `room:{roomID}:queue` | Sorted set queue helper, not used by current REST handlers |
| `room:{roomID}:state` | Hash playback state helper, not used by current REST handlers |
| `song:{youtubeID}` | Song metadata helper |

Frontend should assume the current REST API is backed by the `room:{roomID}`
JSON blob unless the backend is later refactored to use the sorted set helpers.

## Frontend Integration Flow

Recommended frontend flow:

1. User creates a room with `POST /rooms`.
2. Store returned `roomID` and `hostID`.
3. Host creates invite with `POST /rooms/{roomID}/invites`.
4. Friend opens invite link.
5. Frontend calls `POST /invites/{token}/join`.
6. Store returned `roomId` and `userId`.
7. Connect WebSocket with `/ws?roomID={roomId}&userID={userId}`.
8. Fetch room with `GET /rooms/{roomID}`.
9. Search YouTube on the frontend for now, or wait for backend YouTube routes.
10. Add selected song with `POST /rooms/{roomID}/queue`.
11. Refresh queue using `GET /rooms/{roomID}/queue`.
12. Send WebSocket `play`, `pause`, and `seek` events for playback sync.

## Important Frontend Caveats

- Queue REST changes do not currently emit WebSocket `queue:updated` events.
  Frontend should manually refetch the queue after add/vote/delete/next for now.
- There are no auth checks. Any client with a room ID can mutate queue/playback.
- There is no spam protection. The frontend should debounce playback controls.
- The backend does not yet know about YouTube API keys or search.
- The frontend should not trust `userId` as secure identity; it is generated by
  the join route and has no authentication behind it.
- For synced playback, clients should use backend WebSocket timestamps and
  `pong.serverTime` to estimate clock offset.

## Recommended Next Backend Work

If an agent is asked to improve the backend before or during frontend work,
prioritize:

1. Add queue WebSocket broadcasts after queue REST mutations.
2. Add validation for song payloads.
3. Preserve `isPlaying` during `seek` using `data.isPlaying`.
4. Add host/admin checks for queue deletion and queue advance.
5. Add rate limiting for `play`, `pause`, `seek`, and `next`.
6. Move queue mutations from full-room JSON read-modify-write to Redis sorted
   sets or Redis transactions.
7. Add YouTube search/metadata routes.

