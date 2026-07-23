import type { QueueItem } from "../lib/types";
import { formatTime } from "../lib/youtube";

interface Props {
  items: QueueItem[];
  onVote: (songID: string) => void;
  onRemove: (songID: string) => void;
  pendingId?: string | null;
}

export function Queue({ items, onVote, onRemove, pendingId }: Props) {
  if (items.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="text-muted">The queue is quiet.</p>
        <p className="mt-1.5 text-[0.82rem] text-muted2">
          Add a track and it lands here for everyone to vote on.
        </p>
      </div>
    );
  }

  return (
    <ol className="m-0 list-none p-0">
      {items.map((item, i) => (
        <li
          className={`grid grid-cols-[auto_46px_1fr_auto_auto] items-center gap-3 border-t border-line-soft py-2.5 transition-opacity first:border-t-0 ${
            pendingId === item.song.id ? "opacity-50" : ""
          }`}
          key={item.song.id}
        >
          <span className="font-mono text-[0.72rem] text-muted2">
            {String(i + 1).padStart(2, "0")}
          </span>
          <img
            className="h-[46px] w-[46px] rounded-lg bg-surface3 object-cover"
            src={item.song.thumbnail}
            alt=""
            loading="lazy"
          />
          <div className="min-w-0">
            <p
              className="truncate text-[0.9rem] font-medium"
              title={item.song.title}
            >
              {item.song.title}
            </p>
            <p className="mt-0.5 font-mono text-[0.72rem] text-muted2">
              {item.song.duration > 0 ? formatTime(item.song.duration) : "YouTube"}
            </p>
          </div>
          <button
            className="flex flex-col items-center gap-0.5 rounded-[10px] border border-line bg-surface2 px-2 py-1.5 leading-none transition-colors hover:border-amber hover:bg-surface3"
            onClick={() => onVote(item.song.id)}
            aria-label={`Vote for ${item.song.title}`}
          >
            <span className="text-[0.6rem] text-amber">▲</span>
            <span className="font-mono text-[0.82rem] font-semibold">
              {item.votes}
            </span>
          </button>
          <button
            className="rounded-lg p-1.5 text-[0.85rem] text-muted2 transition-colors hover:bg-surface2 hover:text-coral"
            onClick={() => onRemove(item.song.id)}
            aria-label={`Remove ${item.song.title}`}
            title="Remove"
          >
            ✕
          </button>
        </li>
      ))}
    </ol>
  );
}
