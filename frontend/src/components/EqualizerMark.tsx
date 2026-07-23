interface Props {
  /** Bars animate only while playing — otherwise they rest at fixed heights. */
  playing?: boolean;
  size?: number;
  className?: string;
}

// Signature motif: an equalizer that doubles as the SongSpot logo. It pulses in
// the accent gradient while audio plays and holds still when paused.
const BARS = [0.45, 1, 0.7, 0.35, 0.85, 0.55];

export function EqualizerMark({ playing = false, size = 22, className }: Props) {
  return (
    <span
      className={`eq${playing ? " eq--playing" : ""}${
        className ? " " + className : ""
      }`}
      style={{ height: size, width: size * 1.05 }}
      aria-hidden="true"
    >
      {BARS.map((h, i) => (
        <span
          key={i}
          className="eq__bar"
          style={
            {
              "--h": h,
              "--i": i,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}
