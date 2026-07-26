import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { clearSession, getSession } from "../lib/storage";
import { formatTime } from "../lib/youtube";
import { formatRoomCode, isRoomCode, normalizeRoomID } from "../lib/roomCode";
import type { PlaybackAction, QueueItem, RoomData, Song } from "../lib/types";
import { useRoomSocket } from "../hooks/useRoomSocket";
import { YouTubePlayer, type PlayerHandle } from "../components/YouTubePlayer";
import { EqualizerMark } from "../components/EqualizerMark";
import { AddSong } from "../components/AddSong";
import { Queue } from "../components/Queue";
import { SharePanel } from "../components/SharePanel";

const DOT: Record<string, string> = {
  open: "bg-[#5be3a1] shadow-[0_0_0_4px_rgba(91,227,161,0.16)]",
  connecting: "bg-amber",
  closed: "bg-coral",
};

/**
 * Resolves identity before the room mounts. Anyone without a session for this
 * room is sent through `/r/:code`, which joins properly and comes back — so the
 * room page below can take `userId` as a given instead of inventing one.
 */
export function RoomRoute() {
  const { roomID = "" } = useParams();
  const canonical = normalizeRoomID(roomID);

  if (canonical !== roomID) {
    return <Navigate to={`/room/${canonical}`} replace />;
  }

  const session = getSession(canonical);
  if (!session) return <Navigate to={`/r/${canonical}`} replace />;

  return <Room roomID={canonical} userId={session.userId} />;
}

interface RoomProps {
  roomID: string;
  userId: string;
}

function Room({ roomID, userId }: RoomProps) {
  const playerRef = useRef<PlayerHandle>(null);
  const [room, setRoom] = useState<RoomData | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [playerReady, setPlayerReady] = useState(false);
  // Set when the browser refuses the autoplay we asked for on join. The room is
  // playing; this listener just hasn't interacted with the page yet.
  const [needsGesture, setNeedsGesture] = useState(false);
  // Live count of connected listeners, pushed by the server over the socket.
  const [listeners, setListeners] = useState(0);
  // Volume is per-listener (local only, never broadcast) and remembered.
  const [volume, setVolume] = useState(() => {
    const v = Number(localStorage.getItem("songspot.volume"));
    return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 80;
  });
  const [muted, setMuted] = useState(
    () => localStorage.getItem("songspot.muted") === "1",
  );

  // Fallback title lookup for rooms saved before the server started storing
  // full now-playing metadata.
  const songMeta = useRef<Record<string, Song>>({});
  const currentSongRef = useRef<string>("");
  const serverNowRef = useRef<() => number>(() => Date.now());
  // The YouTube player is constructed asynchronously; syncing before it's ready
  // would no-op the load yet still advance currentSongRef, leaving a joiner
  // stuck on a never-loaded video. Gate all syncing on this.
  const playerReadyRef = useRef(false);

  const rememberSongs = useCallback((items: QueueItem[]) => {
    for (const it of items) songMeta.current[it.song.id] = it.song;
  }, []);

  /**
   * Point the player at what the room says should be playing.
   *
   * Normally this only acts when the song *changes* (join, skip, play-now):
   * a queue add or vote leaves the song alone, and re-seeking a playing video
   * on every state update would make it stutter continuously. Live play/pause/
   * seek are handled separately by applyRemotePlayback.
   *
   * `force` re-aligns even on the same song. That's for reconnects, where we
   * may have slept through events and can't assume our playhead is right.
   */
  const syncPlayerToState = useCallback((data: RoomData, force = false) => {
    const s = data.state;
    const player = playerRef.current;
    if (!player || !playerReadyRef.current || !s.currentSong) return;

    const isNewSong = s.currentSong !== currentSongRef.current;
    if (!isNewSong && !force) return;
    currentSongRef.current = s.currentSong;

    // syncTimeMs is where the song was at updatedAt, so a room that's still
    // playing has moved on since. Server time keeps that honest across clocks.
    const elapsed = s.isPlaying ? serverNowRef.current() - s.updatedAt : 0;
    const startSec = Math.max(0, (s.syncTimeMs + elapsed) / 1000);

    if (isNewSong) {
      player.load(s.currentSong, startSec, s.isPlaying);
    } else {
      player.seekTo(startSec);
      if (s.isPlaying) player.play();
      else player.pause();
    }
    setPlaying(s.isPlaying);
  }, []);

  const loadRoom = useCallback(async () => {
    // The room response already carries the queue — fetching /queue alongside
    // it just bought a second round trip for data we already had.
    const data = await api.getRoom(roomID);
    rememberSongs(data.queue);
    setRoom(data);
    setQueue(data.queue);
    return data;
  }, [roomID, rememberSongs]);

  // Apply a peer's playback event to our player, offset-corrected.
  const applyRemotePlayback = useCallback(
    (action: PlaybackAction, syncTimeMs: number, serverTime: number) => {
      const p = playerRef.current;
      if (!p) return;
      const elapsed = action === "play" ? serverNowRef.current() - serverTime : 0;
      const target = Math.max(0, (syncTimeMs + elapsed) / 1000);
      p.seekTo(target);
      if (action === "play") {
        p.play();
        setPlaying(true);
      } else if (action === "pause") {
        p.pause();
        setPlaying(false);
      }
      // "seek" keeps whatever play state we were already in.
    },
    [],
  );

  const { conn, sendPlayback, serverNow } = useRoomSocket(roomID, userId, {
    onPlayback: applyRemotePlayback,
    // The server sends the new value with the event, so a vote or an add costs
    // every listener nothing beyond the message itself.
    onQueueUpdated: (next) => {
      if (next) {
        rememberSongs(next);
        setQueue(next);
      } else {
        void loadRoom();
      }
    },
    onStateUpdated: (next) => {
      if (next) setRoom((prev) => (prev ? { ...prev, state: next } : prev));
      else void loadRoom();
    },
    onPresence: setListeners,
    onKicked: () => {
      clearSession(roomID);
      setLoadError("The host removed you from this room.");
    },
    // We may have slept through a play, a pause, or three whole songs.
    onReconnect: () => {
      loadRoom()
        .then((data) => syncPlayerToState(data, true))
        .catch(() => {});
    },
  });
  serverNowRef.current = serverNow;

  useEffect(() => {
    let alive = true;
    loadRoom().catch(() => {
      if (alive) setLoadError("This room couldn't be found. It may have ended.");
    });
    return () => {
      alive = false;
    };
  }, [loadRoom]);

  // Re-sync whenever room state changes (initial load, skip, play-now).
  useEffect(() => {
    if (room) syncPlayerToState(room);
  }, [room, syncPlayerToState]);

  // Poll the player to drive the progress bar and keep the play/pause button in
  // sync with what the player is *actually* doing (e.g. when the browser blocks
  // autoplay after a refresh, so the UI shows Play instead of a stuck Pause).
  useEffect(() => {
    const t = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      setDuration(p.getDuration());
      if (scrubbing === null) setCurrent(p.getTime());
      const state = p.getState();
      if (state === 1) {
        setPlaying(true);
        setNeedsGesture(false); // sound is coming out; nothing to unblock
      } else if (state === 2 || state === 0) {
        setPlaying(false);
      }
    }, 500);
    return () => clearInterval(t);
  }, [scrubbing]);

  // Apply per-listener volume/mute to the player and remember the choice.
  useEffect(() => {
    if (!playerReady) return;
    playerRef.current?.setVolume(volume);
    playerRef.current?.setMuted(muted);
    localStorage.setItem("songspot.volume", String(volume));
    localStorage.setItem("songspot.muted", muted ? "1" : "0");
  }, [playerReady, volume, muted]);

  // The server keeps the playing song's metadata now, so a listener who arrives
  // mid-song can name it. songMeta covers rooms saved before that existed.
  const currentSongID = room?.state.currentSong;
  const currentTitle = currentSongID
    ? (room?.state.nowPlaying?.title ??
      songMeta.current[currentSongID]?.title ??
      "Now playing")
    : null;

  // Host identity comes from room state, not localStorage: the server is the
  // authority, so this stays right even if local session data is stale.
  const isHost = !!room && room.state.hostID === userId;
  // The host always controls playback; everyone else only when handed the mic.
  const everyoneControls = room?.state.everyoneControls ?? false;
  const canControl = isHost || everyoneControls;

  function togglePlay() {
    const p = playerRef.current;
    if (!p || !canControl) return;
    const ms = Math.floor(p.getTime() * 1000);
    if (playing) {
      p.pause();
      setPlaying(false);
      sendPlayback("pause", ms);
    } else {
      p.play();
      setPlaying(true);
      sendPlayback("play", ms);
    }
  }

  /**
   * Catch up to the room after the browser blocked autoplay. This is a local
   * fix-up, not a control action — it broadcasts nothing, so a listener
   * unmuting themselves never drags the room's playhead around.
   */
  function startListening() {
    const p = playerRef.current;
    const s = room?.state;
    setNeedsGesture(false);
    if (!p || !s) return;
    if (s.currentSong) {
      const elapsed = s.isPlaying ? serverNowRef.current() - s.updatedAt : 0;
      p.seekTo(Math.max(0, (s.syncTimeMs + elapsed) / 1000));
    }
    if (s.isPlaying) p.play();
  }

  function changeVolume(v: number) {
    setVolume(v);
    setMuted(v === 0);
  }

  function toggleMute() {
    if (muted) {
      setMuted(false);
      if (volume === 0) setVolume(30);
    } else {
      setMuted(true);
    }
  }

  function commitSeek(sec: number) {
    if (scrubbing === null) return;
    setScrubbing(null);
    if (!canControl) return;
    const p = playerRef.current;
    p?.seekTo(sec);
    setCurrent(sec);
    sendPlayback("seek", Math.floor(sec * 1000));
    if (playing) p?.play();
  }

  /**
   * Move to the next song. `afterSongID` marks this as an automatic advance
   * because a track ended: the server only acts if that song is still current,
   * so every listener can fire it at once and the queue still moves one step.
   * Without it this is a manual skip and needs playback permission.
   */
  async function skipNext(afterSongID?: string) {
    if (queue.length === 0) return;
    if (!afterSongID && !canControl) return;
    try {
      const state = await api.advanceQueue(roomID, userId, afterSongID);
      setRoom((prev) => (prev ? { ...prev, state } : prev));
      setQueue((q) => q.filter((item) => item.song.id !== state.currentSong));
    } catch {
      // Someone beat us to it, or the queue emptied underneath us. The server
      // broadcasts the truth to everyone either way.
    }
  }

  function applyQueue(next: QueueItem[]) {
    rememberSongs(next);
    setQueue(next);
  }

  async function handlePlayNow(song: Song) {
    if (!canControl) return;
    songMeta.current[song.id] = song;
    const state = await api.playNow(roomID, song, userId);
    setRoom((prev) => (prev ? { ...prev, state } : prev));
  }

  async function handleToggleControl(next: boolean) {
    const state = await api.setControl(roomID, userId, next);
    setRoom((prev) => (prev ? { ...prev, state } : prev));
  }

  async function mutateQueue(fn: () => Promise<QueueItem[]>, id: string) {
    setPendingId(id);
    try {
      applyQueue(await fn());
    } finally {
      setPendingId(null);
    }
  }

  if (loadError) {
    return (
      <main
        className="grid min-h-full place-items-center p-8"
        style={{
          background:
            "radial-gradient(120% 80% at 50% 0%, #14161f, var(--color-bg) 60%)",
        }}
      >
        <div className="flex max-w-[380px] flex-col items-center gap-3.5 text-center">
          <EqualizerMark size={28} />
          <h2 className="display display-sm">Room's closed</h2>
          <p className="text-muted">{loadError}</p>
          <Link className="btn btn-primary mt-1.5" to="/">
            Back to start
          </Link>
        </div>
      </main>
    );
  }

  const shownTime = scrubbing ?? current;
  const hasSong = Boolean(currentSongID);

  return (
    <div
      className="flex min-h-full flex-col"
      style={{
        background:
          "radial-gradient(140% 60% at 80% -10%, #14151d, var(--color-bg) 55%)",
      }}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line-soft px-[clamp(1rem,3vw,2rem)] py-4">
        <Link className="flex items-center gap-2.5 text-ink" to="/">
          <EqualizerMark size={20} playing={playing} />
          <span className="font-display text-[1.05rem] font-bold tracking-[-0.02em]">
            SongSpot
          </span>
        </Link>
        <div className="flex items-center gap-2.5">
          {isRoomCode(roomID) && (
            <span
              className="pill font-mono tracking-[0.1em]"
              title="Room code — share this to invite people"
            >
              {formatRoomCode(roomID)}
            </span>
          )}
          <span className={`h-2 w-2 rounded-full ${DOT[conn]}`} />
          <span className="text-[0.82rem] text-muted">
            {conn === "open"
              ? "In sync"
              : conn === "connecting"
                ? "Connecting…"
                : "Reconnecting…"}
          </span>
          {/* You're always here, so never show 0 before the first update. */}
          <span className="pill">{Math.max(listeners, 1)} listening</span>
        </div>
      </header>

      <main className="grid flex-1 items-start gap-[clamp(1rem,2.5vw,1.8rem)] p-[clamp(1rem,3vw,2rem)] lg:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]">
        <section className="relative">
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-[-8%] -top-[12%] h-[60%] transition-opacity duration-500 ${
              playing ? "opacity-100" : "opacity-0"
            }`}
            style={{
              background:
                "radial-gradient(circle at 50% 0%, rgba(255,141,92,0.14), transparent 60%)",
            }}
          />
          <div className="relative aspect-video overflow-hidden rounded-[22px] border border-line bg-black shadow-[0_24px_60px_-28px_rgba(0,0,0,0.8)]">
            <YouTubePlayer
              ref={playerRef}
              onReady={() => {
                playerReadyRef.current = true;
                setPlayerReady(true);
                if (room) syncPlayerToState(room);
              }}
              onAutoplayBlocked={() => setNeedsGesture(true)}
              onEnded={() => {
                // Everyone fires this; the afterSongID guard keeps it to one
                // advance, so the room moves on even with no host present.
                if (currentSongID && queue.length > 0) {
                  void skipNext(currentSongID);
                }
              }}
              onUserPlay={(at) => {
                if (!canControl) return;
                setPlaying(true);
                sendPlayback("play", Math.floor(at * 1000));
              }}
              onUserPause={(at) => {
                if (!canControl) return;
                setPlaying(false);
                sendPlayback("pause", Math.floor(at * 1000));
              }}
            />

            {/* Browsers won't autoplay into a tab nobody has touched yet, so a
                joiner lands on a silent player. One tap catches them up. */}
            {needsGesture && hasSong && (
              <button
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-center backdrop-blur-sm"
                onClick={startListening}
              >
                <span className="grid h-14 w-14 place-items-center rounded-full bg-accent text-[1.1rem] text-[#1a1206]">
                  ►
                </span>
                <span className="font-display font-bold">Tap to listen</span>
                <span className="text-[0.82rem] text-muted2">
                  Your browser paused the audio until you said so.
                </span>
              </button>
            )}

            {/* Non-controllers can't click the video to pause it. */}
            {hasSong && !canControl && !needsGesture && (
              <div
                className="absolute inset-0 cursor-not-allowed"
                title="The host controls playback"
              />
            )}

            {!hasSong && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-gradient-to-b from-[#101219] to-[#0a0b0f] text-center">
                <EqualizerMark size={40} />
                <p className="mt-2 font-display font-bold">Nothing on yet</p>
                <p className="text-[0.82rem] text-muted2">
                  Add a track and hit skip to start the set.
                </p>
              </div>
            )}
          </div>

          <div className="mt-5 rounded-[14px] border border-line bg-surface p-[1.1rem]">
            <div className="flex min-w-0 items-center gap-2.5">
              <EqualizerMark size={18} playing={playing} />
              <div className="truncate font-display text-[1.1rem] font-bold tracking-[-0.01em]">
                {currentTitle ?? "Waiting for the first track"}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button
                className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-full bg-accent text-[0.95rem] text-[#1a1206] transition hover:scale-105 hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
                onClick={togglePlay}
                disabled={!hasSong || !canControl}
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? "❚❚" : "►"}
              </button>

              <span className="min-w-[42px] text-center font-mono text-[0.78rem]">
                {formatTime(shownTime)}
              </span>
              <input
                className="scrub"
                type="range"
                min={0}
                max={Math.max(duration, 1)}
                step={0.5}
                value={Math.min(shownTime, duration || 0)}
                disabled={!hasSong || !canControl}
                aria-label="Seek"
                onChange={(e) => setScrubbing(Number(e.target.value))}
                // pointerup covers mouse and touch; keyup and blur are what make
                // the scrubber work from the keyboard, which previously left it
                // stuck mid-drag forever.
                onPointerUp={(e) =>
                  commitSeek(Number((e.target as HTMLInputElement).value))
                }
                onKeyUp={(e) =>
                  commitSeek(Number((e.target as HTMLInputElement).value))
                }
                onBlur={(e) => commitSeek(Number(e.target.value))}
                style={
                  {
                    "--pct": `${duration ? (shownTime / duration) * 100 : 0}%`,
                  } as React.CSSProperties
                }
              />
              <span className="min-w-[42px] text-center font-mono text-[0.78rem] text-muted2">
                {formatTime(duration)}
              </span>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface2 text-[0.9rem] transition-colors hover:bg-surface3"
                  onClick={toggleMute}
                  aria-label={muted ? "Unmute" : "Mute"}
                  title={muted ? "Unmute" : "Mute"}
                >
                  {muted || volume === 0 ? "🔇" : volume < 50 ? "🔉" : "🔊"}
                </button>
                <input
                  className="scrub !flex-none w-24"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={muted ? 0 : volume}
                  onChange={(e) => changeVolume(Number(e.target.value))}
                  aria-label="Volume"
                  style={
                    { "--pct": `${muted ? 0 : volume}%` } as React.CSSProperties
                  }
                />
              </div>

              {canControl && (
                <button
                  className="btn shrink-0 !px-3.5 !py-2 text-[0.85rem]"
                  onClick={() => void skipNext()}
                  disabled={queue.length === 0}
                  title="Play the next song in the queue"
                >
                  Next ▸
                </button>
              )}
            </div>

            {isHost ? (
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-line-soft pt-3">
                <span className="text-[0.85rem]">
                  <span className="font-medium">
                    Let everyone control playback
                  </span>
                  <span className="block text-[0.72rem] text-muted2">
                    {everyoneControls
                      ? "Anyone can play, pause, seek, and skip."
                      : "Only you can play, pause, seek, and skip."}
                  </span>
                </span>
                <button
                  role="switch"
                  aria-checked={everyoneControls}
                  aria-label="Let everyone control playback"
                  onClick={() => void handleToggleControl(!everyoneControls)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    everyoneControls ? "bg-accent" : "bg-surface3"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                      everyoneControls ? "left-[22px]" : "left-0.5"
                    }`}
                  />
                </button>
              </div>
            ) : (
              <p className="mt-3 flex items-center gap-2 border-t border-line-soft pt-3 text-[0.8rem] text-muted2">
                {everyoneControls
                  ? "🎛 The host opened playback to everyone."
                  : "🔒 The host controls playback — you can add songs and vote."}
              </p>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-[1.1rem] lg:sticky lg:top-6">
          <div className="card">
            <AddSong
              roomID={roomID}
              canPlayNow={canControl}
              onChanged={applyQueue}
              onPlayNow={handlePlayNow}
            />
          </div>

          <div className="card !pb-1.5">
            <div className="mb-3.5 flex items-baseline justify-between">
              <h2 className="m-0 font-display text-base font-bold">Up next</h2>
              <span className="text-[0.82rem] text-muted2">
                {queue.length} queued
              </span>
            </div>
            <Queue
              items={queue}
              myUserId={userId}
              pendingId={pendingId}
              canRemove={canControl}
              onVote={(id) =>
                mutateQueue(() => api.voteSong(roomID, id, userId), id)
              }
              onRemove={(id) =>
                mutateQueue(() => api.deleteSong(roomID, id, userId), id)
              }
            />
          </div>

          <div className="card">
            <div className="mb-3.5 flex items-baseline justify-between">
              <h2 className="m-0 font-display text-base font-bold">
                Invite the room
              </h2>
            </div>
            <SharePanel roomID={roomID} />
          </div>
        </aside>
      </main>
    </div>
  );
}
