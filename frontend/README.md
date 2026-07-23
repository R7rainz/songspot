# SongSpot Frontend

The web client for SongSpot — a collaborative listening room where everyone
shares one queue and one synced playhead. Built against the Go backend
documented in [`../backend/AGENT.md`](../backend/AGENT.md).

## Stack

- **React 18 + TypeScript + Vite**
- **React Router** for the Home / Room / Join flows
- **YouTube IFrame Player API** for playback
- No CSS framework — a small hand-written design system in `src/styles.css`

## Design

"SongSpot = spotlight." A dark listening-lounge stage lit by a warm
amber→coral accent gradient. The signature element is the **equalizer mark**
(also the logo) that pulses while audio plays.

- **Type:** Bricolage Grotesque (display) · Inter (body) · JetBrains Mono (timecodes/counts)
- **Palette:** graphite neutrals with an `#ffb84d → #ff5d8f` accent gradient

## Run it

The backend must be running first (see `../backend/AGENT.md`):

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

## How it maps to the backend

| Flow | Backend |
| --- | --- |
| Start a room | `POST /rooms` |
| Join via invite | `POST /invites/{token}/join`, link shape `/join/{token}` |
| Load room + queue | `GET /rooms/{id}`, `GET /rooms/{id}/queue` |
| Add / vote / remove | `POST`/`DELETE` on `/rooms/{id}/queue…` |
| Skip | `POST /rooms/{id}/queue/next` |
| Play / pause / seek | WebSocket `play` · `pause` · `seek` events |
| Clock offset | WebSocket `ping` / `pong` |

### Working around documented backend gaps

- **No queue broadcasts:** REST queue mutations don't emit WebSocket events, so
  after every add/vote/remove/skip the client sends a passthrough
  `queue:updated` event; peers refetch on receipt.
- **No song metadata API:** titles come from YouTube's public oEmbed endpoint
  (with a graceful fallback); `duration` is left at `0` until a Data API route
  exists.
- **No auth:** ids in `localStorage` only let a browser rejoin its own room.
  They are not treated as secure identity.
- **`seek` clears `isPlaying` server-side:** the client preserves local play
  state across a seek for a smoother experience.

## Layout

```
src/
  lib/        api client, types, storage, YouTube helpers
  hooks/      useRoomSocket — WS, clock offset, playback/queue events
  components/ YouTubePlayer, EqualizerMark, AddSong, Queue, InvitePanel
  pages/      Home, Room, Join
```
