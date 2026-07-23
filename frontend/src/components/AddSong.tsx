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
    <form className="addsong" onSubmit={submit}>
      <label className="field-label" htmlFor="addsong-input">
        Add to the queue
      </label>
      <div className="addsong__row">
        <input
          id="addsong-input"
          className="input"
          placeholder="Paste a YouTube link…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="btn btn--primary" disabled={busy || !value.trim()}>
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      {error && <p className="alert alert--inline">{error}</p>}
    </form>
  );
}
