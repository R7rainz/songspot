import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { getMyId, saveSession } from "../lib/storage";
import { parseRoomEntry } from "../lib/roomCode";
import { NoteField, Wordmark } from "../components/Brand";
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

  const pasted = /[/:]/.test(code);

  return (
    <main className="home-shell relative flex min-h-full flex-col overflow-hidden p-[clamp(1.2rem,4vw,2.6rem)]">
      <NoteField />

      <header className="relative mx-auto flex w-full max-w-[1480px] items-center justify-between gap-4">
        <Wordmark />
        <span className="chip hidden sm:inline-flex">
          <span className="h-2 w-2 rounded-full border border-ink bg-lagoon" />
          No account needed
        </span>
      </header>

      <div className="relative mx-auto my-auto grid w-full max-w-[1480px] items-center gap-[clamp(2rem,5vw,4rem)] py-10 lg:grid-cols-[1.05fr_1fr]">
        <section className="max-w-[620px]">
          <p className="eyebrow mb-4">Collaborative listening</p>
          <h1 className="display display-pop">
            Tune in
            <br />
            together.
          </h1>
          <p className="lede mt-6">
            One room, one queue, one playhead. Everyone hears the same second of
            the same song — vote up what plays next.
          </p>

          <div className="mt-9 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
            <button
              className="btn btn-primary btn-lg shrink-0"
              onClick={startRoom}
              disabled={creating}
              aria-busy={creating}
            >
              {creating ? "Setting up…" : "Start a room"}
            </button>

            <span className="label hidden sm:block">or</span>

            <form
              className="card-flat flex w-full min-w-0 max-w-[380px] items-center gap-2 !p-2.5"
              onSubmit={goToRoom}
            >
              <input
                // Codes read back as upper-case while typing; a pasted link is
                // left alone, since an ALL-CAPS URL just looks broken.
                className={`input min-w-0 flex-1 !border-0 !px-2 !shadow-none ${
                  pasted ? "" : "input-mono uppercase"
                }`}
                placeholder={pasted ? "" : "K4M9TQ"}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-label="Room code or link"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
              />
              <button className="btn btn-go shrink-0" type="submit" disabled={!code.trim()}>
                Join
              </button>
            </form>
          </div>

          {error && (
            <p className="bubble mt-5 max-w-[420px]" role="alert">
              {error}
            </p>
          )}
        </section>

        <div className="hidden lg:block">
          <RoomPreview />
        </div>
      </div>

      <footer className="relative mx-auto flex w-full max-w-[1480px] flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[0.76rem] font-bold uppercase text-ink3">
        <span>Bring the aux</span>
        <span aria-hidden="true">•</span>
        <span>Leave the arguments</span>
      </footer>
    </main>
  );
}
