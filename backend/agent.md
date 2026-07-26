# SongSpot Backend — Agent Notes

Handoff notes for agents working against this backend, especially on the
frontend.

**The API reference lives in [README.md](./README.md).** This file used to
restate all of it and the two drifted apart; it now covers only what the
reference doesn't — the reasoning, the sharp edges, and the things that will
bite you. If you change a route, update the README.

## The Shape Of The Thing

SongSpot is a collaborative listening room. The backend is a control plane, not
a media server: every browser embeds and drives its own YouTube player, and the
backend only says what should be playing, at what position, and when it said so.

State lives in Redis as one JSON blob per room (`room:{roomID}`), and events fan
out to room members over Redis Pub/Sub (`room_events:{roomID}`).

## Identity And Joining

Rooms are named by a six-character code (`K4M9TQ`) that is also the join
credential — say it aloud or send `/r/K4M9TQ`, same thing either way. Codes come
from an alphabet with no `0`/`O`, no `1`/`I`/`L`, and no vowels.

Always run an incoming room id through `models.NormalizeRoomID`. People type
codes in whatever case they like and add spaces where they paused. Rooms created
before codes have uuid-style ids (`room_a1b2c3d4`) and must keep resolving.

`POST /rooms/{code}/join` is the way in. It also serves as the "does this room
exist" check, which is why the frontend calls it before opening a socket.

There is **no authentication**. `userID` is whatever the client says it is.
Host-only checks compare it to `state.hostID` and stop honest mistakes, nothing
more. Don't build anything on `userID` being trustworthy.

## Playback Sync: The Part That's Easy To Break

`state.syncTimeMs` and `state.updatedAt` are an **anchor pair**: "the song was
at `syncTimeMs` when the server clock read `updatedAt`". Neither means anything
alone. `RoomState.PlayheadMs` is the only correct way to ask where the song is
now.

Consequences worth internalising:

- Touching `updatedAt` without `syncTimeMs` teleports every listener's playhead.
  This is why the control-toggle handler deliberately updates neither.
- Clients should convert with server time, not `Date.now()` — that's what the
  `ping`/`pong` clock-offset exchange is for.
- `seek` must leave `isPlaying` alone. It once didn't, and every scrub silently
  paused the room.

## Concurrency Notes

- Queue mutations are read-modify-write over the whole room blob. Two writers at
  the same instant lose one change. Fine at room scale, wrong in principle — the
  batch route exists partly so playlist import isn't N racing writes.
- Invite `uses` has the same race, so max-uses can be exceeded under a rush.
- Room codes are the exception: they're claimed with `SETNX`, so creation can't
  collide.

## WebSocket Hubs

`ws.Registry` owns one hub per room, started on the first listener and stopped
after the last one leaves. Two things there are load-bearing and easy to undo:

- **`refs` is guarded by the registry mutex, not the hub goroutine.** That's what
  makes "hand out a hub" and "shut a hub down" mutually exclusive. Without it, a
  joiner can take a hub pointer just as the hub decides it's empty, then block
  forever registering with a loop that has returned.
- **The hub closes `Client.Done`, never `Client.Send`.** The client's own read
  pump writes pongs to `Send`, so closing it from the hub is a data race that
  panics the process with "send on closed channel".

Hubs must be torn down. Each one holds a goroutine and a Redis subscription; a
long-lived server that keeps them leaks both for every room it has ever seen.
`PUBSUB CHANNELS 'room_events:*'` on an idle server should come back empty.

## Notes For The Frontend

- REST mutations broadcast their result (`queue:updated`, `state:updated`) with
  the new value attached. Apply it; don't refetch, and don't emit these from the
  client — the server is the only publisher.
- `GET /rooms/{roomID}` already includes the queue. Don't also call `/queue`.
- Nothing is replayed after a dropped socket. Refetch and realign on reconnect.
- `state.nowPlaying` is how a mid-song joiner names the track. Don't rely on
  having seen it in the queue — they haven't.
- Fire `queue/next` with `afterSongID` when a track ends. It's safe from every
  client at once and keeps the room moving when the host has gone.
- Debounce playback controls. There's no rate limiting behind them.

## Useful Commands

```sh
docker compose up -d redis   # local Redis on :6380
go run ./cmd                 # server on :8080
go test ./...
go vet ./...
```
