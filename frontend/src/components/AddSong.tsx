import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { parseVideoId, songFromId } from "../lib/youtube";

interface Props {
  roomID: string;
  onAdded: () => void;
}

export function AddSong({ roomID, onAdded }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const id = parseVideoId(value);
    if (!id) {
      setError("Paste a YouTube link or video id.");
      return;
    }
    setBusy(true);
    try {
      const song = await songFromId(id);
      await api.addSong(roomID, song);
      setValue("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that one.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label
        className="mb-2 block text-[0.8rem] font-medium text-muted"
        htmlFor="addsong-input"
      >
        Add to the queue
      </label>
      <div className="flex gap-2">
        <input
          id="addsong-input"
          className="input"
          placeholder="Paste a YouTube link…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          className="btn btn-primary shrink-0"
          disabled={busy || !value.trim()}
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      {error && <p className="alert mt-2.5">{error}</p>}
    </form>
  );
}
