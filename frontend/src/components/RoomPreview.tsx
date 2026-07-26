import { EqualizerMark } from "./EqualizerMark";

// A non-interactive tabletop deck: the landing page gets its own piece of
// hardware instead of shrinking the room player into a generic preview card.

const listeners = [
  "var(--color-marigold)",
  "var(--color-lagoon)",
  "var(--color-tomato)",
  "var(--color-card)",
];

const upNext = [
  { title: "Neon Freeway", sub: "The Midnights", votes: 12 },
  { title: "Afterglow", sub: "Violet Hour", votes: 9 },
];

export function RoomPreview() {
  return (
    <div
      className="animate-bob relative mx-auto w-full max-w-[440px]"
      aria-hidden="true"
    >
      <div className="preview-deck">
        <div className="preview-deck__handle" />

        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-mono text-[0.58rem] font-bold uppercase text-stage-ink2">
              SongSpot stereo
            </p>
            <p className="font-display text-[1.05rem] font-bold text-stage-ink">
              Party deck <span className="text-marigold">SS-80</span>
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <div className="flex -space-x-2">
              {listeners.map((bg, i) => (
                <span
                  key={i}
                  className="h-6 w-6 rounded-full border border-stage-ink shadow-[0_1px_0_var(--color-shadow)]"
                  style={{ background: bg }}
                />
              ))}
            </div>
            <span className="preview-deck__lamp animate-blink" />
          </div>
        </div>

        <div className="preview-tape mt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[0.56rem] font-bold uppercase text-accent-ink/70">
                Side A · synchronized mix
              </p>
              <p className="truncate font-display text-[1.08rem] font-bold text-accent-ink">
                Midnight Drive
              </p>
            </div>
            <span className="shrink-0 font-mono text-[0.62rem] font-bold text-accent-ink">
              C-60
            </span>
          </div>

          <div className="preview-tape__window mt-3">
            <span className="preview-tape__reel animate-spin-slow">
              <i />
            </span>
            <div className="preview-tape__tape">
              <span>Neon Cassette</span>
              <div className="mt-1.5">
                <EqualizerMark size={14} playing />
              </div>
            </div>
            <span className="preview-tape__reel animate-spin-slow">
              <i />
            </span>
          </div>
        </div>

        <div className="preview-display mt-3">
          <div className="flex items-center justify-between gap-3">
            <span>PLAY · A</span>
            <span className="text-lagoon">4 LISTENERS</span>
          </div>
          <div className="mt-2 flex items-end gap-1">
            {Array.from({ length: 14 }, (_, i) => (
              <span
                key={i}
                className={`preview-display__bar ${
                  i > 10 ? "preview-display__bar--hot" : ""
                }`}
                style={{ height: `${5 + ((i * 7) % 13)}px` }}
              />
            ))}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="preview-transport">■</span>
          <span className="preview-transport">◀◀</span>
          <span className="preview-transport preview-transport--active">▶</span>
          <span className="preview-transport">▶▶</span>
          <div className="ml-1 flex min-w-0 flex-1 items-center gap-2">
            <span className="font-mono text-[0.62rem] font-bold text-stage-ink">
              1:24
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-sm bg-stage3 shadow-inner">
              <div className="h-full w-[42%] bg-marigold" />
            </div>
            <span className="font-mono text-[0.62rem] font-bold text-stage-ink2">
              3:15
            </span>
          </div>
        </div>

        <div className="mt-4">
          <div className="mb-2.5 flex items-center justify-between">
            <p className="font-mono text-[0.58rem] font-bold uppercase text-stage-ink2">
              Auto changer
            </p>
            <span className="font-mono text-[0.58rem] font-bold text-stage-ink2">
              02 TAPES
            </span>
          </div>
          <ul className="space-y-2">
            {upNext.map((t, i) => (
              <li key={t.title} className="preview-slot">
                <span className="preview-slot__index">
                  A{String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.85rem] font-bold text-stage-ink">
                    {t.title}
                  </p>
                  <p className="truncate text-[0.72rem] font-semibold text-stage-ink2">
                    {t.sub}
                  </p>
                </div>
                <span className="font-mono text-[0.68rem] font-bold text-marigold">
                  ▲ {t.votes}
                </span>
                <span className="preview-slot__reel" aria-hidden="true">
                  <i />
                  <i />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
