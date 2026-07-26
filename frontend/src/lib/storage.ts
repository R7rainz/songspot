// Lightweight local identity + per-room session storage.
// Nothing here is secure — the backend has no auth yet (see backend/agent.md).
// These ids only let a browser rejoin the same room it created or joined, and
// let the server tell one listener's votes from another's.

const ME_KEY = "songspot.me";
const sessionKey = (roomID: string) => `songspot.session.${roomID}`;

function randomId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${rand}`;
}

/** Stable id for this browser, used as hostID when creating rooms. */
export function getMyId(): string {
  let id = localStorage.getItem(ME_KEY);
  if (!id) {
    id = randomId("host");
    localStorage.setItem(ME_KEY, id);
  }
  return id;
}

export interface RoomSession {
  roomID: string;
  userId: string;
  isHost: boolean;
}

export function saveSession(s: RoomSession): void {
  localStorage.setItem(sessionKey(s.roomID), JSON.stringify(s));
}

export function getSession(roomID: string): RoomSession | null {
  const raw = localStorage.getItem(sessionKey(roomID));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RoomSession>;
    if (typeof parsed?.userId !== "string" || !parsed.userId) return null;
    return { roomID, userId: parsed.userId, isHost: Boolean(parsed.isHost) };
  } catch {
    return null;
  }
}

export function clearSession(roomID: string): void {
  localStorage.removeItem(sessionKey(roomID));
}
