// Mirrors the backend data models documented in backend/agent.md.

export interface Song {
  id: string; // YouTube video id
  title: string;
  duration: number; // seconds (backend does not enforce units)
  thumbnail: string;
  channel?: string; // uploader, present on search results
}

export interface QueueItem {
  song: Song;
  votes: number;
  voters?: string[]; // user ids who voted — used to show/toggle your own vote
}

export interface RoomState {
  roomID: string;
  hostID: string;
  currentSong: string; // YouTube video id, "" when nothing is playing
  // Full metadata for currentSong. Songs leave the queue when they start
  // playing, so this is the only way a listener who joined mid-song can name
  // what they're hearing. Absent on rooms saved before it existed.
  nowPlaying?: Song;
  isPlaying: boolean;
  syncTimeMs: number;
  updatedAt: number;
  everyoneControls: boolean; // when true, any participant can drive playback
}

export interface RoomData {
  state: RoomState;
  queue: QueueItem[];
  users: string[];
}

export interface Invite {
  token: string;
  expiresAt: string;
  maxUses: number;
}

export interface JoinResult {
  roomId: string;
  userId: string;
}

export type PlaybackAction = "play" | "pause" | "seek";

// Server-sent room events. The backend publishes these after every REST
// mutation, with the new value attached, so listeners neither poll nor depend
// on the mutating client to announce its own change.
export const QUEUE_UPDATED = "queue:updated";
export const STATE_UPDATED = "state:updated";

export interface WSEvent {
  action: string;
  data: Record<string, unknown>;
  timestamp: number;
}
