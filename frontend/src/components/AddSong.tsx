import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { formatTime, parseVideoId, songFromId } from "../lib/youtube";
import type { Song } from "../lib/types";

interface Props {
  roomID: string;
  /** Refetch + broadcast after the queue changes. */
  onChanged: () => void;
  /** Set the room's current song immediately. */
  onPlayNow: (song: Song) => void | Promise<void>;
}

type Mode = "search" | "video" | "playlist";

function detectMode(input: string): Mode {
  if (/[?&]list=/.test(input) || /^(PL|OLAK5uy|RDCLAK|FL|UU)[\w-]{10,}$/.test(input)) {
    return "playlist";
  }
  if (parseVideoId(input)) return "video";
  return "search";
}

export function AddSong({ roomID, onChanged, onPlayNow }: Props) {
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
    setError(null);
    if (!q) {
      setResults([]);
      setPlaylist(null);
      setStatus("idle");
      return;
    }

    const mode = detectMode(q);
    const id = ++reqId.current;
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
    setPendingId(song.id);
    try {
      await api.addSong(roomID, song);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't add that one.");
    } finally {
      setPendingId(null);
    }
  }

  async function playNow(song: Song) {
    setPendingId(song.id);
    try {
      await onPlayNow(song);
    } finally {
      setPendingId(null);
    }
  }

  async function addAll() {
    if (!playlist || playlist.length === 0) return;
    setAddingAll(true);
    try {
      await api.addBatch(roomID, playlist);
      onChanged();
      setQuery("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't import that playlist.");
    } finally {
      setAddingAll(false);
    }
  }

  return (
    <div>
      <label
        className="mb-2 block text-[0.8rem] font-medium text-muted"
        htmlFor="add-music"
      >
        Add music
      </label>
      <input
        id="add-music"
        className="input"
        placeholder="Search a song, or paste a link or playlist…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />

      {status === "loading" && (
        <p className="mt-3 text-[0.82rem] text-muted2">Searching…</p>
      )}
      {error && <p className="alert mt-2.5">{error}</p>}

      {playlist && (
        <div className="mt-3 rounded-[10px] border border-line bg-surface2 p-3">
          {playlist.length === 0 ? (
            <p className="text-[0.85rem] text-muted">
              No tracks found in that playlist.
            </p>
          ) : (
            <>
              <p className="text-[0.85rem]">
                Found{" "}
                <span className="font-semibold text-ink">{playlist.length}</span>{" "}
                {playlist.length === 1 ? "track" : "tracks"} in this playlist.
              </p>
              <button
                className="btn btn-primary mt-2.5 w-full"
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
        <ul className="mt-2 max-h-[340px] overflow-y-auto">
          {results.map((song) => (
            <li
              key={song.id}
              className={`flex items-center gap-3 border-t border-line-soft py-2 first:border-t-0 ${
                pendingId === song.id ? "opacity-50" : ""
              }`}
            >
              <img
                className="h-11 w-11 shrink-0 rounded-lg bg-surface3 object-cover"
                src={song.thumbnail}
                alt=""
                loading="lazy"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.86rem] font-medium" title={song.title}>
                  {song.title}
                </p>
                <p className="truncate font-mono text-[0.7rem] text-muted2">
                  {song.channel ? `${song.channel} · ` : ""}
                  {song.duration > 0 ? formatTime(song.duration) : "—"}
                </p>
              </div>
              <button
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-[0.7rem] text-[#1a1206] transition hover:scale-105 disabled:opacity-45"
                onClick={() => playNow(song)}
                disabled={pendingId === song.id}
                aria-label={`Play ${song.title} now`}
                title="Play now"
              >
                ►
              </button>
              <button
                className="btn shrink-0 !px-3 !py-1.5 text-[0.82rem]"
                onClick={() => add(song)}
                disabled={pendingId === song.id}
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      )}

      {status === "idle" &&
        !error &&
        query.trim() &&
        !playlist &&
        results.length === 0 && (
          <p className="mt-3 text-[0.82rem] text-muted2">No results.</p>
        )}
    </div>
  );
}
