# SongSpot Frontend

The web client for SongSpot — a collaborative listening room where everyone
shares one queue and one synced playhead. Built against the Go backend
documented in [`../backend/agent.md`](../backend/AGENT.md).

## Stack

- **React 18 + TypeScript + Vite**
- **React Router** for the Home / Join / Room flows
- **YouTube IFrame Player API** for playback
- **Tailwind CSS v4** — design tokens and primitives in `src/styles.css`

## Design

"SongSpot = spotlight." A dark listening-lounge stage lit by a warm
amber→coral accent gradient. The signature element is the **equalizer mark**
(also the logo) that pulses while audio plays.

- **Type:** Bricolage Grotesque (display) · Inter (body) · JetBrains Mono (timecodes/counts)
- **Palette:** graphite neutrals with an `#ffb84d → #ff5d8f` accent gradient

## Run it

The backend must be running first (see `../backend/agent.md`):

```sh
cd ../backend
docker compose up -d redis
go run ./cmd            # serves http://localhost:8080
```

Then the frontend:

```sh
pnpm install
pnpm dev               # http://localhost:5173
```

In dev, Vite proxies `/api/*` and `/ws` to the backend on `:8080`, so there's
no CORS setup needed. Point the proxy elsewhere with `BACKEND_URL`.

## Build

```sh
pnpm build             # typecheck + production bundle into dist/
pnpm preview           # serve the built bundle
```

For a production deploy where the backend is reachable directly (and serves
CORS headers), set `VITE_API_URL` and `VITE_WS_URL` — see `.env.example`.

## Getting into a room

A room is its code. `K4M9TQ` is short enough to read down a phone line, and the
share link is just that code with a URL around it — both land in the same place.

| Route | What it is |
| --- | --- |
| `/r/:code` | The door. Joins, saves a session, forwards to the room. |
| `/room/:roomID` | The room itself. Requires a session; bounces to `/r/:code` without one. |
| `/join/:token` | Invite links shared before codes existed. Still works. |

The join box on the home page takes a bare code, a share link, or either of the
older link shapes — people paste all of them. Codes are matched case- and
whitespace-insensitively, so `k4m 9tq` is fine (`src/lib/roomCode.ts`, which
mirrors the backend's `internal/models/roomcode.go`).

Because `/r/:code` is the only place that joins, the room page can take
`userId` as given rather than inventing one.

## How it maps to the backend

| Flow | Backend |
| --- | --- |
| Start a room | `POST /rooms` |
| Join by code | `POST /rooms/{code}/join` |
| Load room (queue included) | `GET /rooms/{id}` |
| Add / vote / remove | `POST`/`DELETE` on `/rooms/{id}/queue…` |
| Search for a song | `GET /search?q=` (keyless InnerTube, backend) |
| Play now | `POST /rooms/{id}/play` (set current song) |
| Import a playlist | `GET /playlist?url=` → `POST /rooms/{id}/queue/batch` |
| Skip | `POST /rooms/{id}/queue/next` |
| Play / pause / seek | WebSocket `play` · `pause` · `seek` events |
| Queue / state changes | WebSocket `queue:updated` · `state:updated` (server-sent) |
| Clock offset | WebSocket `ping` / `pong` |

## Keeping everyone on the same second

- **The server is the only publisher.** `queue:updated` and `state:updated`
  arrive with the new value attached, so mutations are applied, never refetched.
- **`syncTimeMs` is an anchor, not a position.** It's where the song was at
  `updatedAt`; a playing room has moved on since. Convert using server time from
  the `ping`/`pong` offset, not `Date.now()`.
- **Nothing is replayed after a dropped socket.** `onReconnect` refetches and
  force-realigns the playhead, since we may have slept through a whole song.
- **Programmatic player changes must not echo.** `YouTubePlayer` names the state
  transition it expects to cause and stays quiet until it sees it. A flat timer
  loses this race on a slow connection: the load's late `PLAYING` reads as the
  person pressing play, and the client broadcasts its own position to everyone.
- **Browsers won't autoplay into an untouched tab.** A blocked join shows "Tap
  to listen", which re-seeks to the *live* playhead before playing — catching up
  to the room rather than resuming where it parked.

## Known gaps

- **No song metadata API:** titles for raw links come from YouTube's public
  oEmbed endpoint (with a graceful fallback); `duration` stays `0` until a Data
  API route exists. Songs from search and the queue carry real durations.
- **No auth:** ids in `localStorage` only let a browser rejoin its own room.
  They are not treated as secure identity.

## Layout

```
src/
  lib/        api client, types, storage, room codes, YouTube helpers
  hooks/      useRoomSocket — WS, reconnect, clock offset, room events
  components/ YouTubePlayer, EqualizerMark, AddSong, Queue, SharePanel
  pages/      Home, Join, Room
```
