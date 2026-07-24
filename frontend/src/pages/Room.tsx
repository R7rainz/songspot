import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { getMyId, getSession, saveSession } from "../lib/storage";
import { formatTime } from "../lib/youtube";
import type { PlaybackAction, QueueItem, RoomData, Song } from "../lib/types";
import { useRoomSocket } from "../hooks/useRoomSocket";
import { YouTubePlayer, type PlayerHandle } from "../components/YouTubePlayer";
import { EqualizerMark } from "../components/EqualizerMark";
import { AddSong } from "../components/AddSong";
import { Queue } from "../components/Queue";
import { InvitePanel } from "../components/InvitePanel";

const DOT: Record<string, string> = {
  open: "bg-[#5be3a1] shadow-[0_0_0_4px_rgba(91,227,161,0.16)]",
  connecting: "bg-amber",
  closed: "bg-coral",
};

export function Room() {
  const { roomID = "" } = useParams();
  const session = useMemo(() => getSession(roomID), [roomID]);
  const userId = session?.userId ?? getMyId();
  const isHost = session?.isHost ?? false;

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
  // Volume is per-listener (local only, never broadcast) and remembered.
  const [volume, setVolume] = useState(() => {
    const v = Number(localStorage.getItem("songspot.volume"));
    return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 80;
  });
  const [muted, setMuted] = useState(
    () => localStorage.getItem("songspot.muted") === "1",
  );

  // The queue drops a song once it becomes current, so keep a title lookup
  // around for the now-playing header.
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

  // Align the player to the shared playhead described by room state.
  const syncPlayerToState = useCallback((data: RoomData) => {
    const s = data.state;
    const player = playerRef.current;
    if (!player || !playerReadyRef.current || !s.currentSong) return;
    const elapsed = s.isPlaying ? serverNowRef.current() - s.updatedAt : 0;
    const startSec = Math.max(0, (s.syncTimeMs + elapsed) / 1000);
    if (s.currentSong !== currentSongRef.current) {
      currentSongRef.current = s.currentSong;
      player.load(s.currentSong, startSec, s.isPlaying);
    } else if (s.isPlaying) {
      player.seekTo(startSec);
      player.play();
    }
    setPlaying(s.isPlaying);
  }, []);

  const refetch = useCallback(async () => {
    const [data, q] = await Promise.all([
      api.getRoom(roomID),
      api.getQueue(roomID),
    ]);
    rememberSongs(q);
    setRoom(data);
    setQueue(q);
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

  const { conn, sendPlayback, notifyQueueChanged, serverNow } = useRoomSocket(
    roomID,
    userId,
    {
      onPlayback: applyRemotePlayback,
      onQueueUpdated: () => {
        refetch().then(syncPlayerToState).catch(() => {});
      },
    },
  );
  serverNowRef.current = serverNow;

  // Initial load. Register a viewer session if we arrived without one so
  // reconnects reuse the same id (the backend has no auth anyway).
  useEffect(() => {
    if (!session) saveSession({ roomID, userId, isHost: false });
    let alive = true;
    api
      .getRoom(roomID)
      .then(async (data) => {
        const q = await api.getQueue(roomID).catch(() => data.queue);
        if (!alive) return;
        rememberSongs(q);
        setRoom(data);
        setQueue(q);
      })
      .catch(
        () =>
          alive &&
          setLoadError("This room couldn't be found. It may have ended."),
      );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomID]);

  // Re-sync whenever room state changes (initial load, skip, remote refetch).
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
      if (state === 1) setPlaying(true);
      else if (state === 2 || state === 0) setPlaying(false);
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

  const currentTitle = room?.state.currentSong
    ? (songMeta.current[room.state.currentSong]?.title ?? "Now playing")
    : null;

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
    if (!canControl) return;
    const p = playerRef.current;
    p?.seekTo(sec);
    setCurrent(sec);
    setScrubbing(null);
    sendPlayback("seek", Math.floor(sec * 1000));
    if (playing) p?.play();
  }

  async function skipNext() {
    if (queue.length === 0 || !canControl) return;
    try {
      await api.advanceQueue(roomID, userId);
    } catch {
      // Queue emptied from under us (e.g. a peer skipped first) — the refetch
      // below reconciles to the real state either way.
    }
    // advanceQueue returns only RoomState; refetch the full room so `room`,
    // `queue`, and the player all move to the new current song together.
    await refetch();
    notifyQueueChanged();
  }

  async function onSongAdded() {
    const q = await api.getQueue(roomID);
    rememberSongs(q);
    setQueue(q);
    notifyQueueChanged();
  }

  async function handlePlayNow(song: Song) {
    if (!canControl) return;
    songMeta.current[song.id] = song;
    await api.playNow(roomID, song, userId);
    // refetch() updates `room`, which the room-state effect turns into a
    // player.load(); notify peers so they refetch and load the new song too.
    await refetch();
    notifyQueueChanged();
  }

  async function handleToggleControl(next: boolean) {
    await api.setControl(roomID, userId, next);
    await refetch();
    notifyQueueChanged(); // peers refetch and pick up the new permission
  }

  async function mutateQueue(fn: () => Promise<QueueItem[]>, id: string) {
    setPendingId(id);
    try {
      const q = await fn();
      rememberSongs(q);
      setQueue(q);
      notifyQueueChanged();
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
          <h2 className="display display-sm">Room not found</h2>
          <p className="text-muted">{loadError}</p>
          <Link className="btn btn-primary mt-1.5" to="/">
            Back to start
          </Link>
        </div>
      </main>
    );
  }

  const shownTime = scrubbing ?? current;
  const listeners = room?.users.length ?? 0;
  const hasSong = Boolean(room?.state.currentSong);

  return (
    <div
      className="flex min-h-full flex-col"
      style={{
        background:
          "radial-gradient(140% 60% at 80% -10%, #14151d, var(--color-bg) 55%)",
      }}
    >
      <header className="flex items-center justify-between gap-4 border-b border-line-soft px-[clamp(1rem,3vw,2rem)] py-4">
        <Link className="flex items-center gap-2.5 text-ink" to="/">
          <EqualizerMark size={20} playing={playing} />
          <span className="font-display text-[1.05rem] font-bold tracking-[-0.02em]">
            SongSpot
          </span>
        </Link>
        <div className="flex items-center gap-2.5">
          <span className={`h-2 w-2 rounded-full ${DOT[conn]}`} />
          <span className="text-[0.82rem] text-muted">
            {conn === "open"
              ? "In sync"
              : conn === "connecting"
                ? "Connecting…"
                : "Reconnecting…"}
          </span>
          <span className="pill">{listeners} listening</span>
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
              onEnded={() => {
                if (isHost && queue.length > 0) void skipNext();
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
            {/* Non-controllers can't click the video to pause it. */}
            {hasSong && !canControl && (
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
                onChange={(e) => setScrubbing(Number(e.target.value))}
                onMouseUp={(e) =>
                  commitSeek(Number((e.target as HTMLInputElement).value))
                }
                onTouchEnd={(e) =>
                  commitSeek(Number((e.target as HTMLInputElement).value))
                }
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
                  <span className="font-medium">Let everyone control playback</span>
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
              onChanged={() => void onSongAdded()}
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
              pendingId={pendingId}
              canRemove={canControl}
              onVote={(id) => mutateQueue(() => api.voteSong(roomID, id), id)}
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
            <InvitePanel roomID={roomID} />
          </div>
        </aside>
      </main>
    </div>
  );
}
