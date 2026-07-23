import type { Invite, QueueItem, RoomData, RoomState, Song } from "./types";

// Dev: "/api" is proxied to the Go backend by Vite (see vite.config.ts).
// Prod: set VITE_API_URL to the backend origin once it serves CORS headers.
const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Is the backend running?");
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || `Request failed (${res.status})`);
  }

  if (res.status === 204) return undefined as T;
  const body = await res.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

export const api = {
  health: () => request<{ status: string }>("/health"),

  createRoom: (hostID: string) =>
    request<RoomData>("/rooms", {
      method: "POST",
      body: JSON.stringify({ hostID }),
    }),

  getRoom: (roomID: string) => request<RoomData>(`/rooms/${roomID}`),

  createInvite: (roomID: string, maxUses = 5, validHours = 24) =>
    request<Invite>(`/rooms/${roomID}/invites`, {
      method: "POST",
      body: JSON.stringify({ maxUses, validHours }),
    }),

  joinInvite: (token: string) =>
    request<{ roomId: string; userId: string }>(`/invites/${token}/join`, {
      method: "POST",
    }),

  getQueue: (roomID: string) => request<QueueItem[]>(`/rooms/${roomID}/queue`),

  addSong: (roomID: string, song: Song) =>
    request<QueueItem[]>(`/rooms/${roomID}/queue`, {
      method: "POST",
      body: JSON.stringify(song),
    }),

  voteSong: (roomID: string, songID: string) =>
    request<QueueItem[]>(`/rooms/${roomID}/queue/${songID}/vote`, {
      method: "POST",
    }),

  deleteSong: (roomID: string, songID: string) =>
    request<QueueItem[]>(`/rooms/${roomID}/queue/${songID}`, {
      method: "DELETE",
    }),

  // Advances the queue; the backend returns the new RoomState (not full
  // RoomData), so callers should refetch the room after this.
  advanceQueue: (roomID: string) =>
    request<RoomState>(`/rooms/${roomID}/queue/next`, { method: "POST" }),

  // Search YouTube in-app (keyless InnerTube, backed by the Go /search route).
  search: (query: string, limit = 15) =>
    request<Song[]>(
      `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),

  // Resolve a YouTube playlist URL to its songs (preview, no mutation).
  resolvePlaylist: (url: string) =>
    request<{ songs: Song[] }>(`/playlist?url=${encodeURIComponent(url)}`),

  // Append many songs to the queue in one write (used by playlist import).
  addBatch: (roomID: string, songs: Song[]) =>
    request<QueueItem[]>(`/rooms/${roomID}/queue/batch`, {
      method: "POST",
      body: JSON.stringify({ songs }),
    }),

  // Set the room's current song directly ("Play now").
  playNow: (roomID: string, song: Song) =>
    request<RoomState>(`/rooms/${roomID}/play`, {
      method: "POST",
      body: JSON.stringify({ song }),
    }),
};
