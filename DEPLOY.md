# Deploying SongSpot for free

SongSpot has three pieces, each with a free host:

| Piece | Free host | Notes |
| --- | --- | --- |
| **Redis** (state + pub/sub) | [Upstash](https://upstash.com) | Serverless Redis, free tier |
| **Backend** (Go, WebSockets) | [Render](https://render.com) | Free web service; **sleeps after ~15 min idle** (first request wakes it, ~30–60s) |
| **Frontend** (static SPA) | [Vercel](https://vercel.com) | Always-on, instant |

The frontend and backend are hosted separately, so the backend serves **CORS**
headers and the frontend points at the backend via build-time env vars. All of
that is already wired up — you just set a few environment variables.

> Alternatives that also work: backend on **Koyeb** or **Fly.io**; frontend on
> **Netlify** or any static host. The steps are the same shape.

---

## 1. Redis — Upstash

1. Create an account → **Create Database** → pick a region near your backend.
2. Open the database → copy the **`rediss://…`** connection URL (the one with
   TLS, not the REST URL). It looks like
   `rediss://default:XXXX@your-db.upstash.io:6379`.

Keep that URL for step 2.

## 2. Backend — Render

1. **New → Web Service**, connect your GitHub repo.
2. Settings:
   - **Root Directory:** `backend`
   - **Runtime:** Go (auto-detected)
   - **Build Command:** `go build -o app ./cmd`
   - **Start Command:** `./app`
   - **Health Check Path:** `/health`
3. **Environment variables:**
   - `REDIS_URL` = the `rediss://…` URL from step 1
   - (`PORT` is injected by Render — don't set it)
   - Leave `WS_ALLOWED_ORIGINS` / `CORS_ORIGIN` for now; you'll set them in step 4
     once you know the frontend URL.
4. Deploy. When it's live, copy the backend URL, e.g.
   `https://songspot-backend.onrender.com`. Check `…/health` returns
   `{"status":"ok"}`.

## 3. Frontend — Vercel

1. **Add New → Project** → connect the same repo.
2. Settings:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Vite
   - **Build Command:** `pnpm build`
   - **Output Directory:** `dist`
   - (pnpm is auto-detected from `packageManager` in package.json)
3. **Environment variables** (point the app at your backend from step 2):
   - `VITE_API_URL` = `https://songspot-backend.onrender.com` (no trailing slash)
   - `VITE_WS_URL` = `wss://songspot-backend.onrender.com/ws`
4. Deploy. Copy the frontend URL, e.g. `https://songspot.vercel.app`.

> **SPA routing:** the app uses client-side routes (`/room/:id`, `/join/:token`),
> so the host must serve `index.html` for unknown paths or a refresh on a deep
> link 404s. `frontend/vercel.json` already does this. On another static host,
> configure the equivalent single-page-application fallback.

## 4. Wire the origins (the step everyone forgets)

Back in **Render → your backend → Environment**, set these to your frontend URL
and redeploy:

- `WS_ALLOWED_ORIGINS` = `https://songspot.vercel.app`
- `CORS_ORIGIN` = `https://songspot.vercel.app`

Without this, the browser blocks the API calls (CORS) and the WebSocket refuses
the connection (origin check). With it, you're live.

---

## Gotchas

- **Cold starts:** on Render's free tier the backend sleeps when idle. The first
  visit after a nap takes ~30–60s and the socket shows "Reconnecting…" until it
  wakes. The client auto-reconnects. (Optional: a free uptime pinger hitting
  `/health` every ~10 min keeps it warm.)
- **Upstash limits:** the free tier caps daily commands/connections. Fine for a
  few friends; heavy use may need a bigger tier.
- **No auth:** SongSpot has no authentication — anyone with a room link can join
  and (per the mic/host rules) do what those rules allow. Don't put anything
  sensitive in it.

## Running locally (for reference)

```sh
cd backend && docker compose up -d redis && go run ./cmd   # :8080
cd frontend && pnpm install && pnpm dev                    # :5173 (proxies to :8080)
```
