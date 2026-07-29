interface Props {
  /** The room roster, as the server knows it. */
  users: string[];
  hostID: string;
  myUserId: string;
  /** Id currently being removed, so its row can show the pending state. */
  pendingId: string | null;
  onRemove: (userID: string) => void;
}

// There are no display names — identity is a generated id in localStorage — so
// a row is labelled with a short, stable fragment of that id. It is enough to
// tell two people apart and to match against what someone reads out, which is
// all the host needs to pick the right row.
function shortId(userID: string): string {
  const body = userID.replace(/^(user|host)_/, "");
  return (body.slice(0, 6) || userID.slice(0, 6)).toUpperCase();
}

// Deterministic colour per person, so a row keeps the same dot across reloads.
const DOTS = [
  "var(--color-marigold)",
  "var(--color-lagoon)",
  "var(--color-tomato)",
];

function dotColor(userID: string): string {
  let hash = 0;
  for (let i = 0; i < userID.length; i++) {
    hash = (hash * 31 + userID.charCodeAt(i)) >>> 0;
  }
  return DOTS[hash % DOTS.length];
}

/**
 * The host's view of who is in the room, and the only way to remove someone.
 *
 * The roster is append-only on the server: it records everyone who has ever
 * joined, not who is connected right now. The live count in the header is the
 * accurate "who's listening" number, so this list is deliberately framed as
 * everyone who has joined rather than pretending to be presence.
 */
export function People({ users, hostID, myUserId, pendingId, onRemove }: Props) {
  const others = users.filter((id) => id !== hostID);

  return (
    <div>
      <p className="mt-3 text-[0.8rem] font-semibold text-ink2">
        Everyone who has joined this room. Removing someone ends their session —
        they can rejoin with the code.
      </p>

      <ul className="mt-3.5 m-0 list-none p-0">
        {users.map((id) => {
          const isHost = id === hostID;
          const isMe = id === myUserId;
          const removing = pendingId === id;

          return (
            <li
              key={id}
              className={`flex items-center gap-3 border-t border-dashed border-paper3 py-2.5 first:border-t-0 first:pt-0 ${
                removing ? "opacity-45" : ""
              }`}
            >
              <span
                className="h-7 w-7 shrink-0 rounded-full border border-ink"
                style={{ background: dotColor(id) }}
                aria-hidden="true"
              />

              <span className="min-w-0 flex-1 truncate font-mono text-[0.82rem] font-bold tracking-[0.06em]">
                {shortId(id)}
              </span>

              {isHost && <span className="chip shrink-0">Host</span>}
              {isMe && !isHost && <span className="chip shrink-0">You</span>}

              {!isHost && !isMe && (
                <button
                  className="btn shrink-0 !px-3 !py-1 !text-[0.78rem]"
                  onClick={() => onRemove(id)}
                  disabled={pendingId !== null}
                  aria-label={`Remove ${shortId(id)} from the room`}
                >
                  {removing ? "Removing…" : "Remove"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {others.length === 0 && (
        <p className="mt-1 text-[0.82rem] font-semibold text-ink3">
          Nobody else has joined yet. Share the code to get people in.
        </p>
      )}
    </div>
  );
}
