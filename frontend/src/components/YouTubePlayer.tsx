import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { loadYouTubeApi, YT_STATE, type YTPlayer } from "../lib/youtubeApi";

export interface PlayerHandle {
  play(): void;
  pause(): void;
  seekTo(seconds: number): void;
  load(videoId: string, startSeconds: number, autoplay: boolean): void;
  getTime(): number;
  getDuration(): number;
  getState(): number;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
}

interface Props {
  /** Fired when the *user* drives the player (not our programmatic calls). */
  onUserPlay?: (atSeconds: number) => void;
  onUserPause?: (atSeconds: number) => void;
  onEnded?: () => void;
  onReady?: () => void;
}

/**
 * Wraps a YouTube IFrame player behind an imperative handle. Distinguishes
 * user-driven state changes (which should broadcast) from our own programmatic
 * play/pause/seek (which must not echo back out) via `suppressRef`.
 */
export const YouTubePlayer = forwardRef<PlayerHandle, Props>(
  ({ onUserPlay, onUserPause, onEnded, onReady }, ref) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<YTPlayer | null>(null);
    const suppressRef = useRef(false);
    const cbRef = useRef({ onUserPlay, onUserPause, onEnded, onReady });
    cbRef.current = { onUserPlay, onUserPause, onEnded, onReady };
    const [ready, setReady] = useState(false);

    useEffect(() => {
      let cancelled = false;
      const mount = document.createElement("div");
      mount.className = "absolute inset-0 h-full w-full";
      hostRef.current?.appendChild(mount);

      loadYouTubeApi().then((YT) => {
        if (cancelled) return;
        playerRef.current = new YT.Player(mount, {
          width: "100%",
          height: "100%",
          playerVars: {
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            controls: 0,
            disablekb: 1,
          },
          events: {
            onReady: () => {
              setReady(true);
              cbRef.current.onReady?.();
            },
            onStateChange: (e: { data: number }) => {
              const player = playerRef.current;
              if (!player) return;
              if (e.data === YT_STATE.ENDED) {
                cbRef.current.onEnded?.();
                return;
              }
              if (suppressRef.current) return; // our own programmatic change
              const at = player.getCurrentTime();
              if (e.data === YT_STATE.PLAYING) cbRef.current.onUserPlay?.(at);
              else if (e.data === YT_STATE.PAUSED)
                cbRef.current.onUserPause?.(at);
            },
          },
        });
      });

      return () => {
        cancelled = true;
        playerRef.current?.destroy();
        playerRef.current = null;
      };
    }, []);

    // Run a programmatic action without triggering the user-driven callbacks.
    const silently = (fn: (p: YTPlayer) => void) => {
      const p = playerRef.current;
      if (!p) return;
      suppressRef.current = true;
      fn(p);
      window.setTimeout(() => (suppressRef.current = false), 400);
    };

    useImperativeHandle(ref, () => ({
      play: () => silently((p) => p.playVideo()),
      pause: () => silently((p) => p.pauseVideo()),
      seekTo: (s) => silently((p) => p.seekTo(s, true)),
      load: (videoId, startSeconds, autoplay) =>
        silently((p) => {
          p.loadVideoById(videoId, startSeconds);
          if (!autoplay) window.setTimeout(() => p.pauseVideo(), 300);
        }),
      getTime: () => playerRef.current?.getCurrentTime() ?? 0,
      getDuration: () => playerRef.current?.getDuration() ?? 0,
      getState: () => playerRef.current?.getPlayerState() ?? -1,
      setVolume: (v) => playerRef.current?.setVolume(v),
      setMuted: (muted) => {
        const p = playerRef.current;
        if (!p) return;
        if (muted) p.mute();
        else p.unMute();
      },
    }));

    return (
      <div className="absolute inset-0" data-ready={ready}>
        <div ref={hostRef} className="player-host" />
      </div>
    );
  },
);

YouTubePlayer.displayName = "YouTubePlayer";
