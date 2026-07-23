import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { getMyId, saveSession } from "../lib/storage";
import { EqualizerMark } from "../components/EqualizerMark";

export function Home() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function startRoom() {
    setError(null);
    setCreating(true);
    try {
      const hostID = getMyId();
      const room = await api.createRoom(hostID);
      saveSession({ roomID: room.state.roomID, userId: hostID, isHost: true });
      navigate(`/room/${room.state.roomID}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start a room.");
      setCreating(false);
    }
  }

  function goToRoom(e: React.FormEvent) {
    e.preventDefault();
    const id = code.trim();
    if (!id) return;
    // Accept a room id or a pasted invite token/link.
    const token = id.match(/join\/([^/?#]+)/)?.[1];
    if (token) navigate(`/join/${token}`);
    else if (/^[0-9a-fA-F-]{20,}$/.test(id)) navigate(`/join/${id}`);
    else navigate(`/room/${id}`);
  }

  return (
    <main className="home">
      <div className="home__spot" aria-hidden="true" />
      <header className="home__brand">
        <EqualizerMark size={26} />
        <span className="wordmark">SongSpot</span>
      </header>

      <section className="home__hero">
        <p className="eyebrow">Collaborative listening</p>
        <h1 className="display">
          Tune in
          <br />
          together.
        </h1>
        <p className="lede">
          One room, one queue, one playhead. Everyone hears the same second of
          the same song — vote up what plays next.
        </p>

        <div className="home__actions">
          <button
            className="btn btn--primary btn--lg"
            onClick={startRoom}
            disabled={creating}
          >
            {creating ? "Setting the stage…" : "Start a room"}
          </button>

          <form className="joinbox" onSubmit={goToRoom}>
            <input
              className="input"
              placeholder="Room code or invite link"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-label="Room code or invite link"
            />
            <button className="btn" type="submit" disabled={!code.trim()}>
              Join
            </button>
          </form>
        </div>

        {error && <p className="alert">{error}</p>}
      </section>

      <footer className="home__foot">
        <span>Bring the aux. Leave the arguments.</span>
      </footer>
    </main>
  );
}
