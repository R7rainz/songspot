import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { clearSession, getSession } from "../lib/storage";
import { formatTime } from "../lib/youtube";
import { formatRoomCode, isRoomCode, normalizeRoomID } from "../lib/roomCode";
import type { PlaybackAction, QueueItem, RoomData, Song } from "../lib/types";
import { useRoomSocket } from "../hooks/useRoomSocket";
import { YouTubePlayer, type PlayerHandle } from "../components/YouTubePlayer";
import { EqualizerMark } from "../components/EqualizerMark";
import { NoteField, SpeakerIcon, Wordmark } from "../components/Brand";
import { AddSong } from "../components/AddSong";
import { Queue } from "../components/Queue";
import { SharePanel } from "../components/SharePanel";
import { RoomAtmosphere } from "../components/RoomAtmosphere";

// The connection lamp, as a bulb on the front of the cabinet.
const LAMP: Record<string, string> = {
  open: "bg-lagoon",
  connecting: "bg-marigold animate-blink",
  closed: "bg-tomato animate-blink",
};

function actionError(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}

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
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [skipPending, setSkipPending] = useState(false);
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

  function setVolumeFromPointer(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    changeVolume(Math.round(ratio * 10) * 10);
  }

  function handleVolumeKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const currentVolume = muted ? 0 : volume;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      next = Math.min(100, currentVolume + 10);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      next = Math.max(0, currentVolume - 10);
    } else if (e.key === "Home") {
      next = 0;
    } else if (e.key === "End") {
      next = 100;
    }
    if (next === null) return;
    e.preventDefault();
    changeVolume(next);
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
    if (!afterSongID) {
      if (skipPending) return;
      setRoomActionError(null);
      setSkipPending(true);
    }
    try {
      const state = await api.advanceQueue(roomID, userId, afterSongID);
      setRoom((prev) => (prev ? { ...prev, state } : prev));
      setQueue((q) => q.filter((item) => item.song.id !== state.currentSong));
    } catch (e) {
      // Someone beat us to it, or the queue emptied underneath us. The server
      // broadcasts the truth to everyone either way.
      if (!afterSongID) {
        setRoomActionError(actionError(e, "Couldn't skip to the next track."));
      }
    } finally {
      if (!afterSongID) setSkipPending(false);
    }
  }

  function applyQueue(next: QueueItem[]) {
    rememberSongs(next);
    setQueue(next);
  }

  async function handlePlayNow(song: Song) {
    if (!canControl) return;
    setRoomActionError(null);
    songMeta.current[song.id] = song;
    const state = await api.playNow(roomID, song, userId);
    setRoom((prev) => (prev ? { ...prev, state } : prev));
  }

  async function handleToggleControl(next: boolean) {
    if (controlPending) return;
    setRoomActionError(null);
    setControlPending(true);
    try {
      const state = await api.setControl(roomID, userId, next);
      setRoom((prev) => (prev ? { ...prev, state } : prev));
    } catch (e) {
      setRoomActionError(
        actionError(e, "Couldn't change the playback permissions."),
      );
    } finally {
      setControlPending(false);
    }
  }

  async function mutateQueue(fn: () => Promise<QueueItem[]>, id: string) {
    if (pendingId) return;
    setRoomActionError(null);
    setPendingId(id);
    try {
      applyQueue(await fn());
    } catch (e) {
      setRoomActionError(actionError(e, "Couldn't update the queue."));
    } finally {
      setPendingId(null);
    }
  }

  if (loadError) {
    return (
      <main className="relative grid min-h-full place-items-center overflow-hidden p-8">
        <NoteField />
        <div
          className="card relative flex max-w-[420px] flex-col items-center gap-3 text-center"
          role="alert"
        >
          <EqualizerMark size={30} />
          <h2 className="display display-sm">Room's closed</h2>
          <p className="text-[0.95rem] font-semibold text-ink2">{loadError}</p>
          <Link className="btn btn-primary mt-1.5" to="/">
            Back to start
          </Link>
        </div>
      </main>
    );
  }

  if (!room) {
    return (
      <main className="relative grid min-h-full place-items-center overflow-hidden p-8">
        <NoteField />
        <div
          className="card relative flex max-w-[420px] flex-col items-center gap-3 text-center"
          role="status"
          aria-live="polite"
        >
          <EqualizerMark size={30} playing />
          <h2 className="display display-sm">Opening the room…</h2>
          <p className="text-[0.95rem] font-semibold text-ink2">
            Syncing the queue and playhead.
          </p>
        </div>
      </main>
    );
  }

  const shownTime = scrubbing ?? current;
  const hasSong = Boolean(currentSongID);

  return (
    <div className="room-shell relative isolate flex min-h-full flex-col overflow-hidden">
      <RoomAtmosphere playing={playing} />

      <header className="relative z-30 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-ink bg-card px-[clamp(1rem,3vw,2rem)] py-3.5 lg:sticky lg:top-0">
        <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <Link className="inline-flex" to="/" aria-label="SongSpot home">
            <Wordmark playing={playing} />
          </Link>

          <div className="flex flex-wrap items-center gap-2">
            {isRoomCode(roomID) && (
              <span
                className="chip"
                title="Room code — share this to invite people"
              >
                {formatRoomCode(roomID)}
              </span>
            )}
            <span className="chip" role="status" aria-live="polite">
              <span
                className={`h-2.5 w-2.5 rounded-full border border-ink ${LAMP[conn]}`}
                aria-hidden="true"
              />
              {conn === "open"
                ? "In sync"
                : conn === "connecting"
                  ? "Connecting…"
                  : "Reconnecting…"}
            </span>
            {/* You're always here, so never show 0 before the first update. */}
            <span className="chip">
              {Math.max(listeners, 1)}{" "}
              {Math.max(listeners, 1) === 1 ? "listener" : "listeners"}
            </span>
          </div>
        </div>
      </header>

      {roomActionError && (
        <div className="relative z-20 mx-auto w-full max-w-[1500px] px-[clamp(1.1rem,3vw,2rem)] pt-4">
          <div
            className="bubble flex items-center justify-between gap-4"
            role="alert"
          >
            <span>{roomActionError}</span>
            <button
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[1.1rem] text-ink2 hover:bg-card"
              onClick={() => setRoomActionError(null)}
              aria-label="Dismiss error"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </div>
      )}

      {/* content-start matters: main is a flex child that stretches past its
          content, and a stretched grid would pour that slack into the row gap. */}
      <main className="relative z-10 mx-auto grid w-full max-w-[1500px] flex-1 content-start items-start gap-[clamp(1.4rem,3vw,2.2rem)] p-[clamp(1.1rem,3vw,2rem)] pb-[clamp(2rem,4vw,3rem)] lg:grid-cols-[minmax(0,1.75fr)_minmax(330px,1fr)]">
        {/* ---- The stage: one cabinet holding screen and controls ---- */}
        <div className="contents lg:block">
          <div className="cabinet order-1 min-w-0 p-3 sm:p-4">
            <div className="deck-topline mb-3 flex items-center justify-between gap-4 px-1">
              <span>SongSpot synchronous audio deck</span>
              <span className="shrink-0">SS-01</span>
            </div>

            <div className="player-screen relative aspect-video overflow-hidden rounded-lg border border-stage-ink bg-black">
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
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stage/85 text-center"
                  onClick={startListening}
                >
                  <span className="knob h-16 w-16 text-[1.3rem]" aria-hidden="true">
                    ▶
                  </span>
                  <span className="font-display text-[1.15rem] text-stage-ink">
                    Tap to listen
                  </span>
                  <span className="max-w-[26ch] text-[0.82rem] font-semibold text-stage-ink2">
                    Your browser held the audio until you said so.
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
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-stage text-center">
                  <EqualizerMark size={44} onStage />
                  <p className="mt-2 font-display text-[1.2rem] text-stage-ink">
                    Nothing on yet
                  </p>
                  <p className="max-w-[30ch] text-[0.85rem] font-semibold text-stage-ink2">
                    Add a track, then press next to start the set.
                  </p>
                </div>
              )}
            </div>

            {/* ---- Console ---- */}
            <div className="mt-4 flex flex-col gap-3.5">
              {/* Nameplate */}
              <div className="deck-nameplate flex min-w-0 items-center gap-3 rounded-lg border border-stage-ink bg-stage2 px-3.5 py-2.5">
                <EqualizerMark size={18} playing={playing} onStage />
                <div className="min-w-0 flex-1">
                  <span className="block font-mono text-[0.58rem] font-semibold uppercase text-stage-ink2">
                    {hasSong ? "Now playing" : "Deck ready"}
                  </span>
                  <span className="block truncate font-display text-[1.02rem] font-semibold text-stage-ink">
                    {currentTitle ?? "Waiting for the first track"}
                  </span>
                </div>
                <span className="deck-lamp" data-active={playing} aria-hidden="true" />
              </div>

              {/* Transport. Wraps rather than clipping: on a narrow screen the
                  skip button drops to its own line instead of running off the
                  edge of the cabinet. */}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="knob on-stage h-[52px] w-[52px] shrink-0 text-[1.05rem]"
                  onClick={togglePlay}
                  disabled={!hasSong || !canControl}
                  aria-label={playing ? "Pause" : "Play"}
                  aria-pressed={playing}
                >
                  <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
                </button>

                <div className="flex min-w-[176px] flex-1 items-center gap-1.5 sm:gap-2.5">
                  <span className="min-w-9 shrink-0 text-center font-mono text-[0.7rem] font-bold text-stage-ink sm:min-w-11 sm:text-[0.78rem]">
                    {formatTime(shownTime)}
                  </span>
                  <input
                    className="scrub scrub-stage min-w-0"
                    type="range"
                    min={0}
                    max={Math.max(duration, 1)}
                    step={0.5}
                    value={Math.min(shownTime, duration || 0)}
                    disabled={!hasSong || !canControl}
                    aria-label="Seek"
                    onChange={(e) => setScrubbing(Number(e.target.value))}
                    // pointerup covers mouse and touch; keyup and blur are what
                    // make the scrubber work from the keyboard, which previously
                    // left it stuck mid-drag forever.
                    onPointerUp={(e) =>
                      commitSeek(Number((e.target as HTMLInputElement).value))
                    }
                    onPointerCancel={(e) =>
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
                  {/* Capped: an unavailable video reports a nonsense duration,
                      which would otherwise push the row apart. */}
                  <span className="min-w-9 max-w-[72px] shrink-0 truncate text-center font-mono text-[0.7rem] font-bold text-stage-ink2 sm:min-w-11 sm:text-[0.78rem]">
                    {formatTime(duration)}
                  </span>
                </div>

                {canControl && (
                  <button
                    className="btn on-stage ml-auto shrink-0 !px-3.5 !py-1.5 !text-[0.82rem]"
                    onClick={() => void skipNext()}
                    disabled={queue.length === 0 || skipPending}
                    aria-busy={skipPending}
                    title="Play the next song in the queue"
                    aria-label="Play the next song in the queue"
                  >
                    Next <span aria-hidden="true">▸</span>
                  </button>
                )}
              </div>

              {/* Volume, with the speaker grille filling the rest of the row. */}
              <div className="flex items-center gap-3">
                <button
                  className="knob on-stage h-9 w-9 shrink-0 !bg-stage2 !text-stage-ink"
                  onClick={toggleMute}
                  aria-label={muted ? "Unmute" : "Mute"}
                  title={muted ? "Unmute" : "Mute"}
                >
                  <SpeakerIcon
                    level={
                      muted || volume === 0
                        ? "muted"
                        : volume < 50
                          ? "low"
                          : "high"
                    }
                  />
                </button>
                <div
                  className="vu-meter ml-auto"
                  data-playing={playing}
                  role="slider"
                  tabIndex={0}
                  aria-label="Volume"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={muted ? 0 : volume}
                  aria-valuetext={muted ? "Muted" : `${volume}%`}
                  title={muted ? "Muted" : `Volume ${volume}%`}
                  onKeyDown={handleVolumeKey}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setVolumeFromPointer(e);
                  }}
                  onPointerMove={(e) => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      setVolumeFromPointer(e);
                    }
                  }}
                  onPointerUp={(e) => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                  }}
                >
                  {Array.from({ length: 10 }, (_, index) => {
                    const level = muted ? 0 : Math.ceil(volume / 10);
                    return (
                      <span
                        key={index}
                        className="vu-meter__bar"
                        data-on={index < level}
                        data-hot={index >= 8}
                        style={{ height: `${34 + index * 6}%` }}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* ---- Under the cabinet: hand-out and house rules ---- */}
          <div className="order-3 mt-[clamp(1.4rem,3vw,2rem)] grid gap-[clamp(1rem,2vw,1.4rem)] md:grid-cols-2 lg:order-none">
            <SharePanel roomID={roomID} />

            <section className="card" aria-labelledby="controls-heading">
              <h2 className="label" id="controls-heading">
                Who's driving
              </h2>
              {isHost ? (
                <div className="mt-3 flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[0.92rem] font-extrabold">
                      Let everyone control playback
                    </p>
                    <p className="mt-1 text-[0.8rem] font-semibold text-ink2">
                      {everyoneControls
                        ? "Anyone can play, pause, seek, and skip."
                        : "Only you can play, pause, seek, and skip."}
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={everyoneControls}
                    aria-label="Let everyone control playback"
                    onClick={() => void handleToggleControl(!everyoneControls)}
                    disabled={controlPending}
                    className={`relative h-8 w-14 shrink-0 rounded-full border border-ink transition-colors ${
                      everyoneControls ? "bg-lagoon" : "bg-paper3"
                    } disabled:cursor-wait disabled:opacity-50`}
                  >
                    <span
                      className={`absolute top-[3px] h-[22px] w-[22px] rounded-full border border-ink bg-card transition-all ${
                        everyoneControls ? "left-[27px]" : "left-[2px]"
                      }`}
                    />
                  </button>
                </div>
              ) : (
                <p className="mt-3 text-[0.88rem] font-semibold text-ink2">
                  {everyoneControls
                    ? "The host opened playback to everyone — go ahead and drive."
                    : "The host runs playback. You can still add songs and vote on what's next."}
                </p>
              )}
            </section>
          </div>
        </div>

        {/* ---- The rail: music in, music next ---- */}
        <aside className="order-2 flex min-w-0 flex-col gap-[clamp(1rem,2vw,1.4rem)] lg:order-none lg:sticky lg:top-5">
          <div className="card">
            <AddSong
              roomID={roomID}
              canPlayNow={canControl}
              onChanged={applyQueue}
              onPlayNow={handlePlayNow}
            />
          </div>

          <div className="card">
            {/* The heading sits on a staff — the queue is a running order, and
                this is where that order starts. */}
            <div className="relative mb-4 flex items-center justify-between gap-3">
              <div
                className="staff pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2"
                aria-hidden="true"
              />
              <h2 className="heading relative bg-card pr-2.5">Up next</h2>
              <span className="chip relative bg-card">{queue.length} queued</span>
            </div>
            <div className="result-scroll lg:max-h-[440px] lg:overflow-y-auto lg:pr-1">
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
          </div>
        </aside>
      </main>
    </div>
  );
}
