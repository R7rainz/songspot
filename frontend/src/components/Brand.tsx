import { EqualizerMark } from "./EqualizerMark";

interface WordmarkProps {
  /** Drives the equalizer bars, so the logo itself shows the room is playing. */
  playing?: boolean;
  size?: "sm" | "lg";
  className?: string;
}

/**
 * The logo as a stuck-on badge rather than a line of text — the same cut-out
 * treatment every other surface gets, tilted slightly so it reads as placed by
 * hand.
 */
export function Wordmark({ playing, size = "sm", className }: WordmarkProps) {
  const lg = size === "lg";
  return (
    <span
      className={`wordmark-badge tilt inline-flex items-center gap-2 rounded-full border border-accent-ink bg-marigold text-accent-ink ${
        lg ? "px-4 py-2" : "px-3 py-1.5"
      } ${className ?? ""}`}
      style={{ boxShadow: "4px 4px 0 var(--color-shadow)" }}
    >
      <EqualizerMark size={lg ? 22 : 17} playing={playing} />
      <span
        className={`wordmark leading-none ${lg ? "text-[1.5rem]" : "text-[1.1rem]"}`}
      >
        SongSpot
      </span>
    </span>
  );
}

/**
 * Speaker icon, drawn to match everything else: flat fill, heavy outline,
 * round caps. A colour emoji here was the one thing on the cabinet that
 * looked pasted in from another app.
 */
export function SpeakerIcon({ level }: { level: "muted" | "low" | "high" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" fill="currentColor" />
      {level === "muted" ? (
        <>
          <path d="M16.5 9.5l4 5" />
          <path d="M20.5 9.5l-4 5" />
        </>
      ) : (
        <>
          <path d="M15.8 9.4a4 4 0 010 5.2" />
          {level === "high" && <path d="M18.6 7a7.5 7.5 0 010 10" />}
        </>
      )}
    </svg>
  );
}

// Hand-drawn notes that drift up through the page. Purely atmospheric, so they
// stay behind everything and out of the accessibility tree.
const NOTES = [
  { char: "♪", left: "4%", top: "58%", delay: "0s", size: "1.7rem", color: "var(--color-tomato)" },
  { char: "♫", left: "91%", top: "34%", delay: "2.1s", size: "1.4rem", color: "var(--color-lagoon)" },
  { char: "♩", left: "80%", top: "80%", delay: "4.1s", size: "1.2rem", color: "var(--color-marigold)" },
  { char: "♬", left: "1%", top: "22%", delay: "5.8s", size: "1.5rem", color: "var(--color-lagoon)" },
];

export function NoteField() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {NOTES.map((n, i) => (
        <span
          key={i}
          className="note absolute select-none font-display"
          style={{
            left: n.left,
            top: n.top,
            fontSize: n.size,
            color: n.color,
            animationDelay: n.delay,
            WebkitTextStroke: "1.5px var(--color-ink)",
          }}
        >
          {n.char}
        </span>
      ))}
    </div>
  );
}
