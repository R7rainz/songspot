import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { getMyId, saveSession } from "../lib/storage";
import { parseRoomEntry } from "../lib/roomCode";
import { EqualizerMark } from "../components/EqualizerMark";
import { RoomPreview } from "../components/RoomPreview";

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

  // One box for every way a room reaches someone: a code read out over a call,
  // a share link, or one of the older /room/ and /join/ links.
  function goToRoom(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setError(null);

    const entry = parseRoomEntry(code);
    if (entry.kind === "room") navigate(`/r/${entry.roomID}`);
    else if (entry.kind === "invite") navigate(`/join/${entry.token}`);
    else setError("That isn't a room code or link. Codes are six characters, like K4M9TQ.");
  }

  return (
    <main
      className="relative flex min-h-full flex-col overflow-hidden p-[clamp(1.4rem,4vw,3rem)]"
      style={{
        background:
          "radial-gradient(120% 80% at 30% -10%, #14161f 0%, var(--color-bg) 55%)",
      }}
    >
      {/* ambient spotlight */}
      <div
        className="pointer-events-none absolute -top-[22vh] left-1/4 h-[min(90vw,760px)] w-[min(90vw,760px)] -translate-x-1/2 blur-[10px]"
        style={{
          background:
            "radial-gradient(circle, rgba(255,184,77,0.22), rgba(255,93,143,0.10) 42%, transparent 66%)",
        }}
        aria-hidden="true"
      />

      <header className="relative flex items-center gap-2.5">
        <EqualizerMark size={26} />
        <span className="wordmark">SongSpot</span>
      </header>

      <div className="relative my-auto grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
        <section className="max-w-[640px]">
          <p className="eyebrow mb-[1.1rem]">Collaborative listening</p>
          <h1 className="display">
            Tune in
            <br />
            together.
          </h1>
          <p className="lede mt-[1.4rem]">
            One room, one queue, one playhead. Everyone hears the same second of
            the same song — vote up what plays next.
          </p>

          <div className="mt-[2.4rem] flex flex-wrap items-center gap-3">
            <button
              className="btn btn-primary btn-lg"
              onClick={startRoom}
              disabled={creating}
            >
              {creating ? "Setting the stage…" : "Start a room"}
            </button>

            <form className="flex min-w-[260px] flex-1 gap-2" onSubmit={goToRoom}>
              <input
                // Codes read back as upper-case while typing; a pasted link is
                // left alone, since an ALL-CAPS URL just looks broken.
                className={`input flex-1 ${
                  /[/:]/.test(code) ? "" : "input-mono uppercase"
                }`}
                placeholder="Room code, e.g. K4M9TQ"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-label="Room code or link"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
              />
              <button className="btn" type="submit" disabled={!code.trim()}>
                Join
              </button>
            </form>
          </div>

          {error && <p className="alert mt-4">{error}</p>}
        </section>

        <div className="hidden lg:block">
          <RoomPreview />
        </div>
      </div>

      <footer className="relative mt-12 font-mono text-[0.78rem] tracking-wide text-muted2">
        Bring the aux. Leave the arguments.
      </footer>
    </main>
  );
}
