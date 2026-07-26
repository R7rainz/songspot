interface Props {
  /** Bars animate only while playing — otherwise they rest at fixed heights. */
  playing?: boolean;
  size?: number;
  /** Outline the bars in paper instead of ink, for use on the dark cabinet. */
  onStage?: boolean;
  className?: string;
}

// Signature motif: an equalizer that doubles as the SongSpot logo. Drawn like
// everything else in the app — flat fills inside a heavy outline — and it
// bounces only while audio is actually coming out.
const BARS = [
  { h: 0.45, c: "var(--color-marigold)" },
  { h: 1, c: "var(--color-tomato)" },
  { h: 0.7, c: "var(--color-lagoon)" },
  { h: 0.35, c: "var(--color-marigold)" },
  { h: 0.85, c: "var(--color-tomato)" },
];

export function EqualizerMark({
  playing = false,
  size = 22,
  onStage = false,
  className,
}: Props) {
  // Bar width, gap and outline all scale with the mark: a fixed 2px outline on a
  // 16px logo swallows the fill and the whole thing reads as a black smudge.
  const bar = Math.max(3, Math.round(size / 4.6));
  const gap = Math.max(2, Math.round(size / 11));
  const border = size >= 26 ? 2 : 1.5;
  const width = BARS.length * bar + (BARS.length - 1) * gap;

  return (
    <span
      className={[
        "eq",
        playing ? "eq--playing" : "",
        onStage ? "eq--stage" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          height: size,
          width,
          "--gap": `${gap}px`,
          "--bw": `${bar}px`,
          "--bd": `${border}px`,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      {BARS.map((b, i) => (
        <span
          key={i}
          className="eq__bar"
          style={
            {
              "--h": b.h,
              "--i": i,
              "--c": b.c,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}
