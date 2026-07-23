import { EqualizerMark } from "./EqualizerMark";

// A non-interactive teaser of what a live room looks like: spinning record,
// synced now-playing, a couple of queued tracks, and who's listening. It fills
// the hero's right side and shows the product at a glance.

const listeners = [
  "linear-gradient(135deg,#ffb84d,#ff5d8f)",
  "linear-gradient(135deg,#5be3a1,#3aa0ff)",
  "linear-gradient(135deg,#ff5d8f,#a56bff)",
  "linear-gradient(135deg,#ffd166,#ff8a5c)",
];

const upNext = [
  { title: "Neon Freeway", sub: "The Midnights", votes: 12 },
  { title: "Afterglow", sub: "Violet Hour", votes: 9 },
];

const notes = [
  { char: "♪", left: "6%", top: "62%", delay: "0s", cls: "text-amber/70 text-2xl" },
  { char: "♫", left: "88%", top: "40%", delay: "1.8s", cls: "text-coral/70 text-xl" },
  { char: "♩", left: "78%", top: "78%", delay: "3.4s", cls: "text-amber/60 text-lg" },
  { char: "♬", left: "-2%", top: "30%", delay: "4.6s", cls: "text-coral/60 text-xl" },
];

export function RoomPreview() {
  return (
    <div className="relative mx-auto w-full max-w-[400px]">
      {notes.map((n, i) => (
        <span
          key={i}
          className={`note pointer-events-none absolute select-none ${n.cls}`}
          style={{ left: n.left, top: n.top, animationDelay: n.delay }}
          aria-hidden="true"
        >
          {n.char}
        </span>
      ))}

      <div className="animate-float relative rounded-[26px] border border-line bg-surface/80 p-5 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.85)] backdrop-blur-sm">
        <div className="mb-5 flex items-center justify-between">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface2 px-3 py-1 font-mono text-[0.68rem] uppercase tracking-widest text-muted">
            <span className="h-2 w-2 rounded-full bg-[#5be3a1] shadow-[0_0_0_4px_rgba(91,227,161,0.16)]" />
            Live
          </span>
          <div className="flex items-center">
            <div className="flex -space-x-2">
              {listeners.map((bg, i) => (
                <span
                  key={i}
                  className="h-6 w-6 rounded-full border-2 border-surface"
                  style={{ background: bg }}
                />
              ))}
            </div>
            <span className="pl-2.5 text-[0.72rem] text-muted">4 here</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="vinyl animate-spin-slow relative aspect-square w-[72px] shrink-0 rounded-full shadow-[0_10px_30px_-8px_rgba(0,0,0,0.7)]" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-[1.05rem] font-bold leading-tight">
              Midnight Drive
            </p>
            <p className="truncate text-[0.82rem] text-muted">Neon Cassette</p>
            <div className="mt-2">
              <EqualizerMark size={16} playing />
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <span className="font-mono text-[0.72rem] text-ink">1:24</span>
          <div className="h-[6px] flex-1 rounded-full bg-surface3">
            <div className="h-full w-[42%] rounded-full bg-accent" />
          </div>
          <span className="font-mono text-[0.72rem] text-muted2">3:15</span>
        </div>

        <div className="mt-5 border-t border-line-soft pt-4">
          <p className="mb-3 font-mono text-[0.66rem] uppercase tracking-[0.2em] text-muted2">
            Up next
          </p>
          <ul className="space-y-2.5">
            {upNext.map((t, i) => (
              <li key={t.title} className="flex items-center gap-3">
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg font-mono text-[0.7rem] text-[#1a1206]"
                  style={{
                    background:
                      i === 0
                        ? "linear-gradient(135deg,#ffb84d,#ff8a5c)"
                        : "linear-gradient(135deg,#ff5d8f,#a56bff)",
                  }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.85rem] font-medium">{t.title}</p>
                  <p className="truncate text-[0.72rem] text-muted2">{t.sub}</p>
                </div>
                <span className="flex items-center gap-1 rounded-lg border border-line bg-surface2 px-2 py-1 font-mono text-[0.75rem]">
                  <span className="text-[0.55rem] text-amber">▲</span>
                  {t.votes}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
