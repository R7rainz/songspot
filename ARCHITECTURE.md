# Architecture

How SongSpot is put together and why. This document covers system structure,
the synchronization model, the concurrency model, and the known architectural
limits. For the API surface see [`backend/README.md`](backend/README.md); for
setup see [`README.md`](README.md).

## Scope

SongSpot keeps a group of browsers playing the same song at the same position.
It is a coordination service, not a media service. No audio or video passes
through the backend — every client embeds its own YouTube player, and the
backend only distributes the answer to "what should be playing, and where
should the playhead be".

This single decision shapes everything else. Bandwidth is negligible and
scales with the number of *rooms*, not with playback minutes. There is no
transcoding, no CDN, and no media licensing surface. The cost is that the
backend cannot guarantee playback — it can only tell clients what to do, and a
client whose player is blocked, buffering, or throttled will drift.

## System overview

```txt
                    ┌──────────────────────────────────┐
                    │  Browser                         │
                    │                                  │
                    │  React SPA                       │
                    │    useRoomSocket ── clock offset │
                    │    YouTubePlayer ── YT IFrame API│
                    └───────┬──────────────────┬───────┘
                            │ REST             │ WebSocket
                            │ (mutations,      │ (playback events,
                            │  search)         │  server push)
                            v                  v
                    ┌──────────────────────────────────┐
                    │  Go backend                      │
                    │                                  │
                    │  net/http ServeMux ── handlers   │
                    │  ws.Registry ─── one Hub per room│
                    │  internal/music ── InnerTube     │
                    └───────┬──────────────────┬───────┘
                            │ GET/SET          │ PUB/SUB
                            v                  v
                    ┌──────────────────────────────────┐
                    │  Redis                           │
                    │    room:{id}   (JSON blob)       │
                    │    invite:{token}                │
                    │    search:{limit}:{query}        │
                    │    room_events:{id}  (channel)   │
                    └──────────────────────────────────┘
```

Redis does two unrelated jobs: it is the state store, and it is the message bus
between server instances. Combining them keeps the deployment to two processes
while leaving the door open to horizontal scaling.

## Why the split between REST and WebSocket

The two transports carry different kinds of change, and the split is
deliberate:

- **REST** handles anything that mutates durable room content — create, join,
  add, vote, remove, import, advance, play-now, control toggle. These are
  request/response operations where the caller wants a status code and the
  resulting state.
- **WebSocket** handles playback events (`play`, `pause`, `seek`) and all
  server-to-client push. These are latency-sensitive and fan out to everyone.

Crucially, **the server is the only publisher**. A REST mutation does not rely
on the calling client to announce what it just did. The handler writes to Redis
and then publishes the resulting value to `room_events:{roomID}` itself. Two
consequences follow:

1. Clients never poll, and never need to refetch after someone else's change.
2. Every broadcast carries the **new value**, not a bare "something changed"
   nudge. A vote in a room of ten produces one message, not ten refetches.

## Component breakdown

### Frontend (`frontend/`)

A Vite-built React SPA. No global state library — room state lives in the
`Room` page component, because there is exactly one room per page load and
nothing else needs it.

```txt
src/
  lib/         api client, types, localStorage sessions, room codes, YouTube helpers
  hooks/       useRoomSocket — socket lifecycle, reconnect, clock offset, event routing
  components/  YouTubePlayer (imperative handle), AddSong, Queue, SharePanel, Brand marks
  pages/       Home, Join, Room, ErrorPage
```

Two pieces carry most of the complexity:

**`useRoomSocket`** owns the socket. It reconnects with exponential backoff
(1s doubling to a 20s ceiling) multiplied by jitter in the range 0.7–1.3, so a
room full of listeners does not reconnect in lockstep and stampede a server
that just came back. Because browsers freeze timers in background tabs, it also
listens for `visibilitychange` and `online` and reconnects immediately on those
signals — otherwise a phone waking from sleep sits on a dead socket well past
its backoff window.

**`YouTubePlayer`** wraps the YouTube IFrame API behind an imperative handle
and solves the echo problem described below.

### Backend (`backend/`)

Standard-library HTTP with Go 1.22+ method-and-path routing patterns
(`mux.HandleFunc("POST /rooms/{roomID}/queue", …)`). No web framework.

```txt
cmd/main.go              Redis connection, CORS middleware, listen
internal/api/handlers.go REST routes and the /ws upgrade
internal/ws/             Registry, Hub, Client — the real-time layer
internal/models/         Room state, playhead maths, room codes, WS events
internal/music/          Provider interface + InnerTube implementation
```

`internal/music` exists to keep fragile YouTube response-walking out of the HTTP
handlers, behind a one-method `Provider` interface. That boundary is what makes
a future swap to the official YouTube Data API a contained change.

### Redis

| Key | Type | Purpose |
| --- | --- | --- |
| `room:{roomID}` | string (JSON) | Entire room: state, queue, user roster |
| `invite:{token}` | string (JSON) | Legacy invite metadata and use count |
| `search:{limit}:{lowercased query}` | string (JSON) | Search results, cached one hour |
| `room_events:{roomID}` | Pub/Sub channel | Fan-out to every socket in the room |

Room keys carry a 24-hour TTL that every write refreshes. A room in use never
expires; an abandoned one is reclaimed rather than accumulating forever. This
means every write path must pass `models.RoomTTL` — writing with no expiry
silently clears the TTL and makes the room permanent.

## The synchronization model

This is the core of the system and the part most worth understanding.

### Position is an anchor pair, not a value

Room state stores two fields that only mean something together:

```go
SyncTimeMs int64  // position within the current song…
UpdatedAt  int64  // …as of this server timestamp
```

`SyncTimeMs` alone is stale the instant it is written, because a playing room
keeps moving. The live position is derived:

```go
func (s RoomState) PlayheadMs(nowMs int64) int64 {
    if !s.IsPlaying {
        return s.SyncTimeMs
    }
    return s.SyncTimeMs + (nowMs - s.UpdatedAt)
}
```

Updating one field without the other makes every listener's playhead jump. This
is the single most important invariant in the codebase.

### Clock offset, not local time

`nowMs` above must be *server* time. Client clocks are routinely wrong by
seconds, and a listener whose clock is 4 seconds fast would compute a playhead 4
seconds ahead of everyone else.

The frontend maintains a rolling offset using an application-level ping/pong
over the same socket, every 10 seconds:

```txt
client sends  { action: "ping", data: { clientTime } }
server replies (to that client only)
              { action: "pong", data: { clientTime, serverTime } }

rtt    = now - clientTime
offset = serverTime + rtt/2 - now      // assumes a symmetric round trip
```

`serverNow()` is then `Date.now() + offset`. Note this is distinct from the
WebSocket protocol's own ping frames, which `WritePump` sends every 54 seconds
purely as a liveness keepalive against a 60-second read deadline. Two ping
mechanisms, two unrelated jobs.

### Suppressing our own echo

The YouTube player reports state changes without saying who caused them. If the
client broadcast every `PLAYING` transition it observed, then loading a video —
which the client did because the *server* told it to — would look like the user
pressing play, and the client would broadcast its own position back to the room.
Every listener would then yank to that position. The room oscillates.

`YouTubePlayer` therefore names the transition it expects to cause and stays
quiet until it observes it:

```ts
expect(YT_STATE.PLAYING, 8000);
player.loadVideoById(videoId, startSeconds);
```

An earlier implementation used a flat 400ms suppression timer. That is a race
the room loses: on a slow connection the load's `PLAYING` arrives after the
timer lapses, is read as a user action, and is rebroadcast. Naming the expected
state instead of guessing a duration removes the race.

### Reconnect is a resync, not a resume

Nothing is replayed after a dropped socket. A client that was offline may have
missed a pause, a seek, or three entire songs. On reconnect the room page
refetches the room and force-realigns the playhead, rather than assuming its
local position is still meaningful.

### End-of-song advance without a host

When a track ends, every client observes it at roughly the same moment. If each
one posted "advance the queue", the queue would jump N songs forward.

The advance endpoint takes an optional `afterSongID` — the song the caller
believes is currently playing:

```go
if req.AfterSongID != "" && req.AfterSongID != room.State.CurrentSong {
    writeJSON(w, http.StatusOK, room.State)  // someone already advanced
    return
}
```

Exactly one caller wins; the rest receive the settled state and no-op. This also
enables a second behaviour: a track that has genuinely run past its own duration
may be advanced by *any* listener, even in a host-only room. Without that, a
room whose host closed their tab would sit on a finished song forever. The
guard means this can still only ever move the queue one step, at the moment it
was going to move anyway. Songs with unknown duration cannot be proven finished,
so they remain host-only.

`CurrentSongFinished` allows three seconds of slack, because clients report
"ended" from their own player, which can fire slightly before the arithmetic
agrees.

## Concurrency model

The real-time layer is where the concurrency lives.

### Goroutines

Per connected client, two goroutines: `ReadPump` (socket → Redis) and
`WritePump` (hub → socket). Per active room, one `Hub.run` goroutine plus one
`listenToRedis` goroutine draining the Redis subscription.

### The hub owns its client set

Everything touching `h.clients` happens on the single `Hub.run` goroutine,
driven by `register` / `unregister` / `broadcast` channels. The map therefore
needs no lock of its own.

### The registry serialises hub lifecycle

Hubs are created on a room's first listener and destroyed on its last, because
each holds a goroutine and a Redis subscription — keeping one per room the
process has ever seen would leak both for the server's lifetime.

`Registry` maintains a reference count under a mutex rather than exposing a bare
map. That mutex makes "hand out a hub" and "shut a hub down" mutually exclusive.
Without it, a joiner could take a hub pointer moments before the hub decided it
was empty, then block forever registering with a dead event loop.

### Slow clients are dropped, never waited on

```go
select {
case client.Send <- message:
default:
    h.drop(client)
}
```

A client with a full 256-message buffer is either gone or too slow to keep up.
Blocking on it would stall delivery for the entire room, so it is dropped
instead. Room-wide liveness is worth more than one struggling connection.

### Detach signals via `Done`, not by closing `Send`

`drop` closes a separate `Done` channel rather than closing `Send`. `Send` is
also written to by each client's own read pump — pongs go straight back to the
sender — so closing it from the hub would be a data race that panics the server
with "send on closed channel".

## Request and event flows

**Joining a room**

```txt
GET  /r/K4M9TQ                 → SPA route
POST /rooms/K4M9TQ/join        → confirms room exists, returns canonical id + userId
                                 (pass an existing userId to keep votes and host role)
     session saved to localStorage
GET  /room/K4M9TQ              → SPA route, now has a session
GET  /rooms/K4M9TQ             → full RoomData; the response already carries the queue
WS   /ws?roomID=…&userID=…     → hub attaches, presence broadcast to the room
```

`/r/:code` is the only place a join happens, so the room page can treat identity
as given rather than inventing one.

**Someone votes**

```txt
POST /rooms/{id}/queue/{songID}/vote?userID=…
  → toggle userID in the item's Voters set; Votes = len(Voters)
  → stable sort by votes descending
  → save (with TTL)
  → 200 with the new queue to the caller
  → publish queue:updated with the new queue to everyone
```

**Someone presses pause**

```txt
WS  { action: "pause", data: { syncTimeMs } }
  → ReadPump validates payload and checks playback permission
  → read room, set IsPlaying=false, SyncTimeMs, UpdatedAt
  → save (with TTL)
  → stamp event with server time, publish to room_events:{id}
  → Redis fans out → every hub → every client
```

A `seek` deliberately does *not* touch `IsPlaying`. An earlier version checked
only whether the action was `play`, which paused the room every time anyone
dragged the scrubber.

## Authorization model

There is no authentication. `userID` is self-asserted and stored in
`localStorage`. What exists is a permission *convention*, enforced server-side
against room state:

- The host (`RoomState.HostID`) may always drive playback.
- `EveryoneControls` opens playback to all participants when the host enables it.
- Anyone in a room may add songs and vote, always.
- A finished song may be advanced by anyone, as described above.

These checks are applied on both the REST paths and in the WebSocket read pump,
so a hand-crafted socket message is subject to the same rule as a REST call.
They keep honest clients coordinated; they are not a security boundary, because
nothing stops a caller from claiming to be the host's `userID`.

## Room codes

Codes are six characters from `23456789BCDFGHJKMNPQRSTVWXZ` — no `0`/`O`, no
`1`/`I`/`L`, and no vowels at all. Dropping vowels costs keyspace but guarantees
a random code can never spell a real word. That leaves 27⁶ ≈ 387 million
combinations, which is enough that guessing a live room is impractical while
staying short enough to read over a phone call.

Generation uses `crypto/rand` with rejection sampling: taking a raw byte modulo
27 would favour the first 13 letters, since 256 is not a multiple of 27. Codes
are then claimed with `SETNX` and up to eight retries, so two rooms created in
the same instant cannot collide — the keyspace makes collisions rare, not
impossible.

`NormalizeRoomID` canonicalises input on the way in, so `k4m 9tq`, `K4M-9TQ`
and `K4M9TQ` all resolve to the same room. Frontend `roomCode.ts` mirrors this
logic and must be kept in step with `models/roomcode.go`.

## Known architectural limits

These are real constraints of the current design, not a wishlist.

**Room writes are read-modify-write.** Every handler fetches the whole
`room:{id}` blob, mutates it in Go, and writes it back. There is no `WATCH`,
Lua script, or per-field structure. Two concurrent writers can therefore lose
one another's change — two people adding a song at the same instant may end up
with only one song queued. The same applies to invite `uses`, meaning a max-uses
limit can be exceeded under a concurrent rush. Fixing this means either moving
the queue into a Redis data structure or wrapping mutations in a Lua script.

**Presence is per-instance.** `broadcastPresence` counts sockets attached to the
current process, deduped by user. Running a second instance would report two
separate counts for the same room. The fan-out already goes through Redis, so
the state layer is ready for multiple instances; the presence count is the piece
that is not.

**InnerTube is unofficial.** Search and playlist metadata come from YouTube's
internal web API, using a public key embedded in YouTube's own frontend. This
avoids API key management and quota entirely, which is why it was chosen for
this stage, but YouTube can change its response shape at any time. The parser
tests in `internal/music` run against captured fixtures, so they verify the
parsing logic — not that YouTube still returns that shape.

**Sync is best-effort per client.** The backend distributes intent. It cannot
observe whether a given browser actually reached the requested position, and a
client that is buffering or throttled in a background tab will drift until the
next event realigns it.

**No rate limiting.** Playback events, votes, and queue mutations are
unthrottled, and each playback event costs a Redis read and write.

## If this needed to scale

The likely order of work, cheapest first:

1. Move presence counting through Redis so instances agree.
2. Make queue and invite mutations atomic (Lua script or restructured keys).
3. Add rate limiting on playback events and votes.
4. Replace InnerTube with the official YouTube Data API behind the existing
   `music.Provider` interface.

The pub/sub fan-out and the stateless HTTP layer already permit running several
backend instances behind a load balancer; items 1 and 2 are what stand between
the current design and doing so safely.
