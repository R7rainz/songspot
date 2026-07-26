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
  /**
   * Fired when the browser refused an autoplay we asked for. The room is
   * playing but this listener is silent until they interact with the page.
   */
  onAutoplayBlocked?: () => void;
}

/** How long to wait for a load to reach PLAYING before calling autoplay blocked. */
const AUTOPLAY_GRACE_MS = 2500;

/**
 * Wraps a YouTube IFrame player behind an imperative handle. Distinguishes
 * user-driven state changes (which should broadcast to the room) from our own
 * programmatic play/pause/seek (which must not echo back out).
 */
export const YouTubePlayer = forwardRef<PlayerHandle, Props>(
  ({ onUserPlay, onUserPause, onEnded, onReady, onAutoplayBlocked }, ref) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<YTPlayer | null>(null);
    // Set while the component unmounts, so the PAUSED/ENDED events YouTube
    // fires during teardown aren't broadcast as a real pause or skip.
    const tearingDownRef = useRef(false);
    const cbRef = useRef({
      onUserPlay,
      onUserPause,
      onEnded,
      onReady,
      onAutoplayBlocked,
    });
    cbRef.current = {
      onUserPlay,
      onUserPause,
      onEnded,
      onReady,
      onAutoplayBlocked,
    };
    const [ready, setReady] = useState(false);

    // Suppression: which state change we're expecting to cause ourselves.
    //
    // This used to be a flat 400ms timer, which is a race the room loses. A
    // load or play on a slow connection can take seconds to actually reach
    // PLAYING; once the timer had lapsed that arrival looked like the person
    // pressing play, so the client broadcast a "play" at its own position and
    // yanked everyone else's playhead to match. Now we name the state we're
    // waiting for and stay quiet until we see it (or give up).
    const expectRef = useRef<{ state: number; until: number } | null>(null);
    const autoplayTimerRef = useRef<number | undefined>(undefined);
    // YT.Player hands back an object well before that object has any methods on
    // it — they appear when the iframe finishes loading and onReady fires. Every
    // accessor below goes through here, because reaching for one early throws a
    // TypeError, and the room's 500ms progress poll starts on mount.
    const readyRef = useRef(false);
    const live = (): YTPlayer | null =>
      readyRef.current ? playerRef.current : null;

    const expect = (state: number, windowMs: number) => {
      expectRef.current = { state, until: Date.now() + windowMs };
    };

    /** True if `state` is one we caused, which also consumes the expectation. */
    const wasExpected = (state: number): boolean => {
      const pending = expectRef.current;
      if (!pending) return false;
      if (Date.now() > pending.until) {
        expectRef.current = null;
        return false;
      }
      if (pending.state !== state) return false;
      expectRef.current = null;
      return true;
    };

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
              readyRef.current = true;
              setReady(true);
              cbRef.current.onReady?.();
            },
            onStateChange: (e: { data: number }) => {
              if (tearingDownRef.current) return; // ignore unmount-induced events
              const player = playerRef.current;
              if (!player) return;

              if (e.data === YT_STATE.PLAYING) {
                // Playback started, so autoplay clearly wasn't blocked.
                window.clearTimeout(autoplayTimerRef.current);
              }
              if (e.data === YT_STATE.ENDED) {
                cbRef.current.onEnded?.();
                return;
              }
              if (wasExpected(e.data)) return; // our own doing

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
        tearingDownRef.current = true;
        readyRef.current = false;
        window.clearTimeout(autoplayTimerRef.current);
        playerRef.current?.destroy();
        playerRef.current = null;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      play: () => {
        const p = live();
        if (!p) return;
        expect(YT_STATE.PLAYING, 8000);
        p.playVideo();
      },

      pause: () => {
        const p = live();
        if (!p) return;
        expect(YT_STATE.PAUSED, 4000);
        p.pauseVideo();
      },

      seekTo: (seconds) => {
        const p = live();
        if (!p) return;
        // A seek re-buffers, and coming out of the buffer reports PLAYING. If
        // we're already playing, that arrival is ours, not the person's.
        if (p.getPlayerState() === YT_STATE.PLAYING) {
          expect(YT_STATE.PLAYING, 8000);
        }
        p.seekTo(seconds, true);
      },

      load: (videoId, startSeconds, autoplay) => {
        const p = live();
        if (!p) return;
        window.clearTimeout(autoplayTimerRef.current);

        if (autoplay) {
          expect(YT_STATE.PLAYING, 8000);
          p.loadVideoById(videoId, startSeconds);
          // If we never reach PLAYING, the browser blocked us — which is the
          // normal outcome for a fresh tab that hasn't been clicked yet.
          autoplayTimerRef.current = window.setTimeout(() => {
            const state = live()?.getPlayerState();
            if (state !== YT_STATE.PLAYING && state !== YT_STATE.BUFFERING) {
              cbRef.current.onAutoplayBlocked?.();
            }
          }, AUTOPLAY_GRACE_MS);
          return;
        }

        // cue, not load: loadVideoById always starts playing, so joining a
        // paused room used to blast a second of audio and burn the buffer
        // before a follow-up pause caught it. cueVideoById just gets ready.
        expect(YT_STATE.CUED, 8000);
        p.cueVideoById(videoId, startSeconds);
      },

      getTime: () => live()?.getCurrentTime() ?? 0,
      getDuration: () => live()?.getDuration() ?? 0,
      getState: () => live()?.getPlayerState() ?? -1,
      setVolume: (v) => live()?.setVolume(v),
      setMuted: (muted) => {
        const p = live();
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
