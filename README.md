# SongSpot

A collaborative listening room. One person starts a room, shares a six-character
code, and everyone who joins gets the same queue and the same playhead — the
same second of the same song. Anyone can add tracks and vote on what plays next.

SongSpot does not stream audio. Each browser embeds and drives its own YouTube
player; the backend is a coordination layer that tells every client what should
be playing and where the playhead should be.

## How it works

```txt
Browser (React + YouTube IFrame player)
  |  REST  : rooms, join, queue, search, playlist
  |  WS    : play / pause / seek, server-pushed room events
  v
Go backend (net/http + gorilla/websocket)
  |  Redis JSON blobs : room, invite, and search-cache state
  |  Redis Pub/Sub    : fan-out to every socket in a room
  v
Redis
```

Playback sync rests on a single idea: the server stores `syncTimeMs` (a position
within the current song) paired with `updatedAt` (when it recorded that). The
two are an anchor, not independent values — a room that is still playing has
moved on since. Clients convert using a server-time offset measured over the
socket rather than their own clock, so listeners in different time zones with
skewed clocks still land on the same second.

## Repository layout

```txt
backend/         Go coordination server, Redis state, YouTube metadata lookup
frontend/        React + TypeScript SPA (Vite)
ARCHITECTURE.md  System design, sync model, concurrency model, known limits
DEPLOY.md        Step-by-step production deployment guide
```

Further documentation:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces fit together and why:
  the playhead anchor pair, clock-offset estimation, echo suppression, hub
  lifecycle, and the constraints of the current design
- [`backend/README.md`](backend/README.md) — full REST and WebSocket API
  reference, data models, Redis keys, engineering notes
- [`backend/agent.md`](backend/agent.md) — backend working notes
- [`frontend/README.md`](frontend/README.md) — client architecture, design
  system, sync rules

## Requirements

- Go 1.26+
- Node.js 20+ and pnpm
- Docker (for local Redis), or a Redis instance you point at yourself

## Running locally

Start Redis and the backend from `backend/`:

```sh
cd backend
docker compose up -d redis
go run ./cmd                 # http://localhost:8080
```

Then the frontend, in a second shell:

```sh
cd frontend
pnpm install
pnpm dev                     # http://localhost:5173
```

Vite proxies `/api/*` and `/ws` to the backend on `:8080` during development, so
there is no CORS or WebSocket-origin configuration to do locally. Open
`http://localhost:5173`, start a room, and open the share link in a second
browser window to see two clients stay in sync.

## Configuration

Both halves run with working defaults. Copy the relevant `.env.example` to
`.env` to override.

### Backend

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `REDIS_URL` | `localhost:6380` | `host:port`, or a full `rediss://` URL |
| `CORS_ORIGIN` | `*` | Comma-separated origins allowed to call the REST API |
| `WS_ALLOWED_ORIGINS` | empty | Comma-separated exact origins allowed to open a WebSocket |

When `WS_ALLOWED_ORIGINS` is empty, same-host, `localhost`, and `127.0.0.1` are
accepted. Set it explicitly in production.

### Frontend

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKEND_URL` | `http://localhost:8080` | Dev-only proxy target, read by `vite.config.ts` |
| `VITE_API_URL` | dev proxy (`/api`) | Absolute REST base URL for production builds |
| `VITE_WS_URL` | dev proxy (`/ws`) | Absolute WebSocket URL for production builds |

## Rooms and links

A room is its code. `K4M9TQ` is drawn from an alphabet with no vowels and no
lookalike characters (`0`/`O`, `1`/`I`/`L`), so it can be read down a phone line
without being misheard and cannot accidentally spell a word. Codes are matched
case- and whitespace-insensitively, so `k4m 9tq` resolves the same way.

| Route | Purpose |
| --- | --- |
| `/` | Landing page: start a room, or enter a code or link |
| `/r/:code` | The door — joins, saves a session, forwards to the room |
| `/room/:roomID` | The room itself; redirects to `/r/:code` without a session |
| `/join/:token` | Invite links issued before room codes existed |

`/r/:code` is the only place that performs a join, so the room page can treat
identity as given rather than inventing it.

## Tests

```sh
cd backend && go test ./... && go vet ./...
cd frontend && pnpm typecheck
```

Backend coverage focuses on the parts most likely to break silently: the
YouTube response parsers (fixture-driven), room-code generation and
normalisation, and the playhead maths.

## Deployment

See [`DEPLOY.md`](DEPLOY.md) for a complete walkthrough. The short version: the
frontend and backend are deployed separately, so the backend must be told the
frontend's origin via `CORS_ORIGIN` and `WS_ALLOWED_ORIGINS`, and the frontend
must be told the backend's URL via `VITE_API_URL` and `VITE_WS_URL`. The static
host also needs a single-page-application fallback so deep links survive a
refresh; `frontend/vercel.json` provides this for Vercel.

## Current limitations

These are known and deliberate for the current stage of the project:

- **No authentication.** User IDs are self-asserted and stored in
  `localStorage`. Host-only controls are not a security boundary — anyone with a
  room code can join and mutate the queue. Do not put anything sensitive in a
  room.
- **No rate limiting.** Playback events, votes, and queue mutations are
  unthrottled.
- **Queue writes are not atomic.** Handlers read-modify-write the whole room
  blob in Redis, so two simultaneous writers can lose one another's change.
- **YouTube metadata comes from InnerTube**, YouTube's unofficial internal API.
  It needs no API key, but it can break if YouTube changes its response shape.
- **Presence is per-instance.** The listener count only reflects sockets on the
  current server process.
- **Rooms expire.** Room keys carry a 24-hour TTL that every write refreshes, so
  an active room persists and an abandoned one is reclaimed.
