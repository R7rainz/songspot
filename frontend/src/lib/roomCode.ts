// Room codes are the app's front door: short enough to read down a phone line,
// and the thing a share link carries. This mirrors the backend's
// internal/models/roomcode.go — keep the two in step.

/** Same alphabet as the backend: no 0/O, no 1/I/L, no vowels. */
export const ROOM_CODE_ALPHABET = "23456789BCDFGHJKMNPQRSTVWXZ";
export const ROOM_CODE_LENGTH = 6;

/**
 * Canonicalise whatever someone typed or pasted. People add spaces and dashes
 * when they read a code aloud, and type it in whatever case they feel like.
 * Legacy uuid-derived ids (`room_a1b2c3d4`) are lower-cased and left otherwise
 * intact so links shared before short codes existed still work.
 */
export function normalizeRoomID(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("room_")) return trimmed.toLowerCase();
  return trimmed.replace(/[\s\-_]/g, "").toUpperCase();
}

export function isRoomCode(value: string): boolean {
  if (value.length !== ROOM_CODE_LENGTH) return false;
  return [...value].every((ch) => ROOM_CODE_ALPHABET.includes(ch));
}

/** A room id the backend might know: a short code, or a legacy uuid-based id. */
export function isRoomID(value: string): boolean {
  return isRoomCode(value) || /^room_[0-9a-f]{4,}$/.test(value);
}

/** Display form: `K4M 9TQ` gets read aloud and transcribed better than `K4M9TQ`. */
export function formatRoomCode(roomID: string): string {
  if (!isRoomCode(roomID)) return roomID;
  return `${roomID.slice(0, 3)} ${roomID.slice(3)}`;
}

export type ParsedEntry =
  | { kind: "room"; roomID: string }
  | { kind: "invite"; token: string }
  | { kind: "unknown" };

/**
 * Work out what a person pasted into the join box. Accepts a bare code, a
 * share link, a legacy `/room/<id>` or `/join/<token>` link, and a raw invite
 * token — because all of those have been valid at some point and someone will
 * paste every one of them.
 */
export function parseRoomEntry(input: string): ParsedEntry {
  const raw = input.trim();
  if (!raw) return { kind: "unknown" };

  // Anything link-shaped: pull the meaningful segment out of the path.
  const path = raw.match(/^[a-z]+:\/\/[^/]+(\/.*)$/i)?.[1] ?? (raw.startsWith("/") ? raw : null);
  if (path) {
    const invite = path.match(/\/join\/([^/?#]+)/i)?.[1];
    if (invite) return { kind: "invite", token: decodeURIComponent(invite) };

    const room = path.match(/\/(?:r|room)\/([^/?#]+)/i)?.[1];
    if (room) {
      const roomID = normalizeRoomID(decodeURIComponent(room));
      return isRoomID(roomID) ? { kind: "room", roomID } : { kind: "unknown" };
    }
    return { kind: "unknown" };
  }

  // A bare uuid is an old invite token.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return { kind: "invite", token: raw.toLowerCase() };
  }

  const roomID = normalizeRoomID(raw);
  return isRoomID(roomID) ? { kind: "room", roomID } : { kind: "unknown" };
}
