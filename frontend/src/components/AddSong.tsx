import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { formatTime, parseVideoId, songFromId } from "../lib/youtube";
import type { QueueItem, Song } from "../lib/types";

interface Props {
  roomID: string;
  /** Whether this participant may play a track immediately (host / everyone). */
  canPlayNow: boolean;
  /**
   * Receives the updated queue the mutation returned, so adding a song doesn't
   * cost a follow-up round trip to read back what we were just told.
   */
  onChanged: (queue: QueueItem[]) => void;
  /** Set the room's current song immediately. */
  onPlayNow: (song: Song) => void | Promise<void>;
}

type Mode = "search" | "video" | "playlist";

function detectMode(input: string): Mode {
  if (/[?&]list=/.test(input) || /^(PL|OLAK5uy|RD|FL|UU)[\w-]{10,}$/.test(input)) {
    return "playlist";
  }
  if (parseVideoId(input)) return "video";
  return "search";
}

export function AddSong({ roomID, canPlayNow, onChanged, onPlayNow }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Song[]>([]);
  const [playlist, setPlaylist] = useState<Song[] | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [addingAll, setAddingAll] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    // Invalidate work that is already in flight even when the new value is
    // empty or too short to start another request.
    const id = ++reqId.current;
    setError(null);
    if (!q) {
      setResults([]);
      setPlaylist(null);
      setStatus("idle");
      return;
    }

    const mode = detectMode(q);
    // Wait for a couple of characters before hitting the backend on plain text,
    // so single-letter keystrokes don't fire a search.
    if (mode === "search" && q.length < 2) {
      setResults([]);
      setPlaylist(null);
      setStatus("idle");
      return;
    }

    setStatus("loading");
    setPlaylist(null);
    setResults([]);

    const timer = setTimeout(async () => {
      try {
        if (mode === "playlist") {
          const { songs } = await api.resolvePlaylist(q);
          if (id !== reqId.current) return;
          setPlaylist(songs);
        } else if (mode === "video") {
          const song = await songFromId(parseVideoId(q)!);
          if (id !== reqId.current) return;
          setResults([song]);
        } else {
          const songs = await api.search(q);
          if (id !== reqId.current) return;
          setResults(songs);
        }
        setStatus("idle");
      } catch (e) {
        if (id !== reqId.current) return;
        setError(
          e instanceof ApiError ? e.message : "Something went wrong searching.",
        );
        setStatus("error");
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [query]);

  async function add(song: Song) {
    if (pendingId) return;
    setError(null);
    setPendingId(song.id);
    try {
      onChanged(await api.addSong(roomID, song));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't add that one.");
    } finally {
      setPendingId(null);
    }
  }

  async function playNow(song: Song) {
    if (pendingId) return;
    setError(null);
    setPendingId(song.id);
    try {
      await onPlayNow(song);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't play that one.");
    } finally {
      setPendingId(null);
    }
  }

  async function addAll() {
    if (!playlist || playlist.length === 0) return;
    setError(null);
    setAddingAll(true);
    try {
      onChanged(await api.addBatch(roomID, playlist));
      setQuery("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't import that playlist.");
    } finally {
      setAddingAll(false);
    }
  }

  return (
    <div>
      <label className="label mb-2 block" htmlFor="add-music">
        Add music
      </label>
      <input
        id="add-music"
        className="input"
        placeholder="Search or paste a link…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />

      {status === "loading" && (
        <p
          className="status-copy mt-3"
          role="status"
          aria-live="polite"
        >
          Searching…
        </p>
      )}
      {error && (
        <p className="bubble mt-4" role="alert">
          {error}
        </p>
      )}

      {playlist && (
        <div className="mt-4 border-l-4 border-lagoon bg-lagoon-tint px-3 py-3">
          {playlist.length === 0 ? (
            <p className="text-[0.86rem] font-bold text-ink2">
              No tracks found in that playlist.
            </p>
          ) : (
            <>
              <p className="text-[0.88rem] font-bold">
                <span className="font-mono text-[1.05rem]">{playlist.length}</span>{" "}
                {playlist.length === 1 ? "track" : "tracks"} in this playlist.
              </p>
              <button
                className="btn btn-primary mt-3 w-full"
                onClick={addAll}
                disabled={addingAll}
              >
                {addingAll ? "Adding…" : `Add all ${playlist.length}`}
              </button>
            </>
          )}
        </div>
      )}

      {results.length > 0 && (
        <ul className="result-scroll mt-3 max-h-[340px] space-y-2 overflow-y-auto pr-1">
          {results.map((song) => (
            <li
              key={song.id}
              className={`cassette-result flex items-center gap-3 px-2.5 py-2 ${
                pendingId === song.id ? "opacity-45" : ""
              }`}
            >
              <div className="cassette-art shrink-0">
                <img
                  className="h-11 w-11 object-cover"
                  src={song.thumbnail}
                  alt=""
                  loading="lazy"
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.86rem] font-bold" title={song.title}>
                  {song.title}
                </p>
                <p className="truncate font-mono text-[0.7rem] font-bold text-ink3">
                  {song.channel ? `${song.channel} · ` : ""}
                  {song.duration > 0 ? formatTime(song.duration) : "—"}
                </p>
              </div>
              {canPlayNow && (
                <button
                  className="knob h-8 w-8 shrink-0 text-[0.68rem]"
                  onClick={() => playNow(song)}
                  disabled={pendingId !== null}
                  aria-label={`Play ${song.title} now`}
                  title="Play now"
                >
                  <span aria-hidden="true">▶</span>
                </button>
              )}
              <button
                className="btn shrink-0 !px-3 !py-1.5 !text-[0.8rem]"
                onClick={() => add(song)}
                disabled={pendingId !== null}
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      )}

      {status === "idle" &&
        !error &&
        query.trim().length >= 2 &&
        !playlist &&
        results.length === 0 && (
          <p className="status-copy mt-3">
            No results.
          </p>
        )}
    </div>
  );
}
