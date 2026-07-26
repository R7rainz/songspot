import { useState } from "react";
import { formatRoomCode, isRoomCode } from "../lib/roomCode";

interface Props {
  roomID: string;
}

type Copied = "code" | "link" | null;

/**
 * How a room gets shared. The code and the link are the same thing wearing
 * different clothes: read the code down a phone line, or send the link and let
 * it do the typing. Both land on `/r/:code`, which joins and forwards.
 */
export function SharePanel({ roomID }: Props) {
  const [copied, setCopied] = useState<Copied>(null);
  const [error, setError] = useState<string | null>(null);

  const link = `${location.origin}/r/${roomID}`;
  // Pre-code rooms have long uuid-ish ids that aren't worth showing off.
  const showCode = isRoomCode(roomID);

  async function copy(value: string, what: Exclude<Copied, null>) {
    try {
      await navigator.clipboard.writeText(value);
      setError(null);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("Couldn't copy — select it and copy manually.");
    }
  }

  async function share() {
    try {
      await navigator.share({
        title: "SongSpot",
        text: showCode
          ? `Join my SongSpot room — code ${roomID}`
          : "Join my SongSpot room",
        url: link,
      });
    } catch {
      // The person dismissed the share sheet; nothing to report.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {showCode && (
        <div className="flex items-center gap-3 rounded-[12px] border border-line bg-surface2 p-3">
          <div className="min-w-0 flex-1">
            <p className="text-[0.72rem] uppercase tracking-[0.14em] text-muted2">
              Room code
            </p>
            <p className="mt-1 font-mono text-[1.6rem] font-bold leading-none tracking-[0.12em] text-ink">
              {formatRoomCode(roomID)}
            </p>
          </div>
          <button
            className="btn shrink-0"
            onClick={() => copy(roomID, "code")}
            aria-label="Copy room code"
          >
            {copied === "code" ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      <div>
        <label
          className="mb-1.5 block text-[0.72rem] uppercase tracking-[0.14em] text-muted2"
          htmlFor="share-link"
        >
          Or send the link
        </label>
        <div className="flex gap-2">
          <input
            id="share-link"
            className="input input-mono min-w-0 flex-1"
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            className="btn shrink-0"
            onClick={() => copy(link, "link")}
            aria-label="Copy invite link"
          >
            {copied === "link" ? "Copied" : "Copy"}
          </button>
          {typeof navigator !== "undefined" && "share" in navigator && (
            <button className="btn btn-ghost shrink-0" onClick={share}>
              Share
            </button>
          )}
        </div>
      </div>

      <p className="text-[0.78rem] text-muted2">
        Anyone with the code can join and add songs.
      </p>
      {error && <p className="alert">{error}</p>}
    </div>
  );
}
