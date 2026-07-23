import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { saveSession } from "../lib/storage";
import { EqualizerMark } from "../components/EqualizerMark";

export function Join() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true; // guard StrictMode's double-invoke — join is not idempotent
    api
      .joinInvite(token)
      .then(({ roomId, userId }) => {
        saveSession({ roomID: roomId, userId, isHost: false });
        navigate(`/room/${roomId}`, { replace: true });
      })
      .catch((e) =>
        setError(
          e instanceof ApiError
            ? e.message
            : "That invite didn't work. It may have expired or been used up.",
        ),
      );
  }, [token, navigate]);

  return (
    <main
      className="grid min-h-full place-items-center p-8"
      style={{
        background:
          "radial-gradient(120% 80% at 50% 0%, #14161f, var(--color-bg) 60%)",
      }}
    >
      <div className="flex max-w-[380px] flex-col items-center gap-3.5 text-center">
        <EqualizerMark size={28} playing={!error} />
        {error ? (
          <>
            <h2 className="display display-sm">Invite unavailable</h2>
            <p className="text-muted">{error}</p>
            <button
              className="btn btn-primary mt-1.5"
              onClick={() => navigate("/")}
            >
              Back to start
            </button>
          </>
        ) : (
          <>
            <h2 className="display display-sm">Joining the room…</h2>
            <p className="text-muted">Grabbing you a seat.</p>
          </>
        )}
      </div>
    </main>
  );
}
