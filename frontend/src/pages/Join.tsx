import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { getSession, saveSession } from "../lib/storage";
import { isRoomID, normalizeRoomID } from "../lib/roomCode";
import { EqualizerMark } from "../components/EqualizerMark";
import { NoteField } from "../components/Brand";

/**
 * The single door into a room. Serves `/r/:code` (a room code, typed or from a
 * share link) and `/join/:token` (invite links handed out before codes
 * existed). Both end at `/room/:roomID` with a session saved, so the room page
 * itself never has to deal with "who am I".
 */
export function Join() {
  const { code, token } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true; // guard StrictMode's double-invoke — joining isn't idempotent

    const join = async () => {
      if (token) {
        const { roomId, userId } = await api.joinInvite(token);
        saveSession({ roomID: roomId, userId, isHost: false });
        navigate(`/room/${roomId}`, { replace: true });
        return;
      }

      const roomID = normalizeRoomID(code ?? "");
      if (!isRoomID(roomID)) {
        setError("That doesn't look like a room code. They're six characters, like K4M9TQ.");
        return;
      }

      // Reuse the id we already had here, so refreshing or following the link a
      // second time doesn't orphan this browser's votes — or, for the host,
      // quietly demote them to an ordinary listener.
      const existing = getSession(roomID);
      const { roomId, userId } = await api.joinRoom(roomID, existing?.userId);
      saveSession({
        roomID: roomId,
        userId,
        isHost: existing?.isHost ?? false,
      });
      navigate(`/room/${roomId}`, { replace: true });
    };

    join().catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) {
        setError("That room isn't around any more. Rooms wind down after a day of quiet.");
      } else if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError("Couldn't get you in. Check the code and try again.");
      }
    });
  }, [code, token, navigate]);

  return (
    <main className="relative grid min-h-full place-items-center overflow-hidden p-8">
      <NoteField />
      <div
        className="card relative flex max-w-[420px] flex-col items-center gap-3 text-center"
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        <EqualizerMark size={30} playing={!error} />
        {error ? (
          <>
            <h2 className="display display-sm">Can't get in</h2>
            <p className="text-[0.95rem] font-semibold text-ink2">{error}</p>
            <Link className="btn btn-primary mt-1.5" to="/">
              Back to start
            </Link>
          </>
        ) : (
          <>
            <h2 className="display display-sm">Joining the room…</h2>
            <p className="text-[0.95rem] font-semibold text-ink2">
              Grabbing you a seat.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
