// Mirrors the backend data models documented in backend/AGENT.md.

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
}

export interface RoomState {
  roomID: string;
  hostID: string;
  currentSong: string; // YouTube video id, "" when nothing is playing
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

export type PlaybackAction = "play" | "pause" | "seek";

// Custom passthrough event we emit so peers refetch after REST queue changes,
// which the backend does not broadcast on its own (see AGENT.md caveats).
export const QUEUE_UPDATED = "queue:updated";

export interface WSEvent {
  action: string;
  data: Record<string, unknown>;
  timestamp: number;
}
