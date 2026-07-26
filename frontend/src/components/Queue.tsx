import type { QueueItem } from "../lib/types";
import { formatTime } from "../lib/youtube";

interface Props {
  items: QueueItem[];
  myUserId: string;
  onVote: (songID: string) => void;
  onRemove: (songID: string) => void;
  canRemove: boolean;
  pendingId?: string | null;
}

// The running order is the point of the queue, so the position marker is the
// loudest thing in each row — a note head with the number printed in it. The
// track that plays next is marigold; everything waiting behind it is lagoon.
export function Queue({
  items,
  myUserId,
  onVote,
  onRemove,
  canRemove,
  pendingId,
}: Props) {
  if (items.length === 0) {
    return (
      <div className="border-y border-dashed border-paper3 px-4 py-7 text-center">
        <p className="font-display text-[1.05rem] text-ink">Nothing lined up</p>
        <p className="mt-1.5 text-[0.83rem] font-semibold text-ink2">
          Add a track and it lands here for everyone to vote on.
        </p>
      </div>
    );
  }

  return (
    <ol className="cassette-stack m-0 list-none space-y-2.5 p-0">
      {items.map((item, i) => {
        const voted = item.voters?.includes(myUserId) ?? false;
        const onDeck = i === 0;
        const pending = pendingId !== null && pendingId !== undefined;
        return (
          <li
            className={`cassette-row grid grid-cols-[auto_44px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-2 px-2.5 py-2 transition-opacity sm:grid-cols-[auto_48px_minmax(0,1fr)_auto] sm:gap-x-3 ${
              onDeck ? "cassette-row--on-deck" : ""
            } ${
              pendingId === item.song.id ? "opacity-45" : ""
            }`}
            aria-busy={pendingId === item.song.id}
            key={item.song.id}
          >
            <span
              className="cassette-index grid h-8 w-8 shrink-0 place-items-center font-mono text-[0.68rem] font-bold"
              style={{
                background: onDeck
                  ? "var(--color-marigold)"
                  : "var(--color-lagoon)",
              }}
              aria-hidden="true"
            >
              A{String(i + 1).padStart(2, "0")}
            </span>

            <div className="cassette-art">
              <img
                className="h-11 w-11 object-cover sm:h-12 sm:w-12"
                src={item.song.thumbnail}
                alt=""
                loading="lazy"
              />
            </div>

            <div className="min-w-0">
              <p
                className="truncate text-[0.9rem] font-bold"
                title={item.song.title}
              >
                {item.song.title}
              </p>
              <p className="mt-0.5 truncate font-mono text-[0.72rem] font-bold text-ink3">
                {onDeck ? "On deck · " : ""}
                {item.song.channel ? `${item.song.channel} · ` : ""}
                {item.song.duration > 0
                  ? formatTime(item.song.duration)
                  : "YouTube"}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <button
                className={`inline-flex items-center gap-1.5 rounded-full border border-ink px-2.5 py-1 leading-none transition-[transform,box-shadow,background-color] duration-100 hover:-translate-y-px active:translate-y-[2px] active:!shadow-none disabled:cursor-wait disabled:opacity-45 disabled:hover:translate-y-0 ${
                  voted ? "bg-marigold" : "bg-card"
                }`}
                style={{ boxShadow: "2px 2px 0 var(--color-shadow)" }}
                onClick={() => onVote(item.song.id)}
                disabled={pending}
                aria-pressed={voted}
                title={voted ? "Remove your vote" : "Vote"}
                aria-label={`${voted ? "Remove your vote for" : "Vote for"} ${item.song.title}`}
              >
                <span
                  className={`text-[0.6rem] ${voted ? "text-ink" : "text-tomato"}`}
                  aria-hidden="true"
                >
                  ▲
                </span>
                <span className="font-mono text-[0.82rem] font-bold">
                  {item.votes}
                </span>
              </button>

              {canRemove && (
                <button
                  className="grid h-7 w-7 place-items-center rounded-full text-[1.1rem] leading-none text-ink3 transition-colors hover:bg-tomato-tint hover:text-tomato disabled:cursor-wait disabled:opacity-45"
                  onClick={() => onRemove(item.song.id)}
                  disabled={pending}
                  aria-label={`Remove ${item.song.title}`}
                  title="Remove"
                >
                  <span aria-hidden="true">×</span>
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
