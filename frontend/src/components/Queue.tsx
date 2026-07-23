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
      <div className="queue-empty">
        <p className="muted">The queue is quiet.</p>
        <p className="muted muted--sm">
          Add a track and it lands here for everyone to vote on.
        </p>
      </div>
    );
  }

  return (
    <ol className="queue">
      {items.map((item, i) => (
        <li
          className={`track${pendingId === item.song.id ? " track--pending" : ""}`}
          key={item.song.id}
        >
          <span className="track__pos">{String(i + 1).padStart(2, "0")}</span>
          <img
            className="track__art"
            src={item.song.thumbnail}
            alt=""
            loading="lazy"
          />
          <div className="track__meta">
            <p className="track__title" title={item.song.title}>
              {item.song.title}
            </p>
            <p className="track__sub">
              {item.song.duration > 0 ? formatTime(item.song.duration) : "YouTube"}
            </p>
          </div>
          <button
            className="votebtn"
            onClick={() => onVote(item.song.id)}
            aria-label={`Vote for ${item.song.title}`}
          >
            <span className="votebtn__arrow">▲</span>
            <span className="votebtn__count">{item.votes}</span>
          </button>
          <button
            className="iconbtn"
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
