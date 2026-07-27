import { useState } from "react";
import { formatRoomCode, isRoomCode } from "../lib/roomCode";

interface Props {
  roomID: string;
}

type Copied = "code" | "link" | null;

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some browsers expose the API but deny it outside a direct interaction.
    }
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  try {
    field.select();
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    field.remove();
  }
}

/**
 * How a room gets handed over, drawn as a ticket stub: the code is the big
 * printed thing, and the tear-off edge carries the actions. The code and the
 * link are the same thing wearing different clothes — read the code down a
 * phone line, or send the link and let it do the typing. Both land on
 * `/r/:code`, which joins and forwards. Legacy `room_...` identifiers use the
 * same ticket as a room key so older backend deployments do not lose the
 * primary invite UI.
 */
export function SharePanel({ roomID }: Props) {
  const [copied, setCopied] = useState<Copied>(null);
  const [error, setError] = useState<string | null>(null);

  const link = `${location.origin}/r/${roomID}`;
  // Pre-code rooms have long uuid-ish ids that aren't worth showing off.
  const showCode = isRoomCode(roomID);
  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  async function copy(value: string, what: Exclude<Copied, null>) {
    try {
      await writeClipboard(value);
      setError(null);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setError(
        `Copy isn't available in this browser. You can type the room ${
          showCode ? "code" : "key"
        } instead.`,
      );
    }
  }

  async function share() {
    try {
      await navigator.share({
        title: "SongSpot",
        text: `Join my SongSpot room — ${showCode ? "code" : "key"} ${roomID}`,
        url: link,
      });
    } catch (e) {
      // Dismissing the native share sheet is expected; other failures are not.
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError("Couldn't open the share sheet. Try copying the link instead.");
    }
  }

  const copiedMessage =
    copied === "code"
      ? `Room ${showCode ? "code" : "key"} copied`
      : copied === "link"
        ? "Invite link copied"
        : "";

  return (
    <div>
      {/* No overflow clipping — the torn-edge notches straddle the border. */}
      <section
        className="stub flex items-stretch"
        aria-labelledby="room-code-heading"
      >
        <div className="min-w-0 flex-1 p-4">
          <h2 className="label" id="room-code-heading">
            {showCode ? "Room code" : "Room key"}
          </h2>
          <p
            className={`mt-1.5 break-all font-mono font-bold leading-none text-accent-ink ${
              showCode
                ? "text-[1.7rem] sm:text-[2rem]"
                : "text-[1.05rem] sm:text-[1.2rem]"
            }`}
          >
            {formatRoomCode(roomID)}
          </p>
          <p className="mt-2.5 text-[0.78rem] font-semibold text-accent-ink/80">
            Anyone with this {showCode ? "code" : "key"} can join and add songs.
          </p>
        </div>

        <div className="stub__perf flex shrink-0 flex-col justify-center gap-2 p-3.5">
          <button
            className="btn !px-3 !py-1.5 !text-[0.78rem]"
            onClick={() => copy(roomID, "code")}
            aria-label={`Copy room ${showCode ? "code" : "key"}`}
          >
            {copied === "code"
              ? "Copied"
              : `Copy ${showCode ? "code" : "key"}`}
          </button>
          <button
            className="btn !px-3 !py-1.5 !text-[0.78rem]"
            onClick={() => copy(link, "link")}
            aria-label="Copy invite link"
          >
            {copied === "link" ? "Copied" : "Copy link"}
          </button>
          {canShare && (
            <button
              className="btn btn-ghost !px-3 !py-1.5 !text-[0.78rem]"
              onClick={share}
            >
              Share
            </button>
          )}
        </div>
      </section>
      <span className="sr-only" role="status" aria-live="polite">
        {copiedMessage}
      </span>
      {error && (
        <p className="bubble mt-4" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
