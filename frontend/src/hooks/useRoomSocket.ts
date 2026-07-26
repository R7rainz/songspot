import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackAction, QueueItem, RoomState, WSEvent } from "../lib/types";
import { QUEUE_UPDATED, STATE_UPDATED } from "../lib/types";

function wsUrl(roomID: string, userID: string): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  const base =
    explicit ??
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}roomID=${encodeURIComponent(
    roomID,
  )}&userID=${encodeURIComponent(userID)}`;
}

export type ConnState = "connecting" | "open" | "closed";

interface Handlers {
  onPlayback?: (
    action: PlaybackAction,
    syncTimeMs: number,
    serverTime: number,
  ) => void;
  /** The queue changed; the new queue is attached when the server sent it. */
  onQueueUpdated?: (queue?: QueueItem[]) => void;
  /** Room state changed (new song, control handed over, …). */
  onStateUpdated?: (state?: RoomState) => void;
  /** Live count of people connected to the room. */
  onPresence?: (count: number) => void;
  /** The host removed us from the room. */
  onKicked?: () => void;
  /**
   * The socket (re)opened. On a reconnect we may have slept through play,
   * pause or a whole song, so the room page refetches and realigns here.
   */
  onReconnect?: () => void;
}

// Reconnect backoff. A server that's down shouldn't get hammered once every two
// seconds for as long as the tab stays open, but a blip should recover fast.
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 20_000;

/**
 * Manages the room WebSocket: reconnection, a rolling clock-offset estimate via
 * ping/pong, and typed helpers for playback broadcasts. `offset` is
 * (serverTime - clientTime); add it to Date.now() for server time.
 */
export function useRoomSocket(
  roomID: string | null,
  userID: string | null,
  handlers: Handlers,
) {
  const [conn, setConn] = useState<ConnState>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const offsetRef = useRef(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!roomID || !userID) return;
    let closed = false;
    let attempts = 0;
    let opened = false; // have we ever connected? distinguishes reconnect from first connect
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      setConn("connecting");
      const ws = new WebSocket(wsUrl(roomID, userID));
      socketRef.current = ws;

      ws.onopen = () => {
        setConn("open");
        attempts = 0;
        const ping = () =>
          ws.readyState === WebSocket.OPEN &&
          ws.send(
            JSON.stringify({
              action: "ping",
              data: { clientTime: Date.now() },
              timestamp: 0,
            }),
          );
        ping();
        pingTimer = setInterval(ping, 10_000);

        if (opened) handlersRef.current.onReconnect?.();
        opened = true;
      };

      ws.onmessage = (ev) => {
        let msg: WSEvent;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.action) {
          case "pong": {
            const clientTime = Number(msg.data.clientTime) || 0;
            const serverTime = Number(msg.data.serverTime) || 0;
            const rtt = Date.now() - clientTime;
            offsetRef.current = serverTime + rtt / 2 - Date.now();
            break;
          }
          case "play":
          case "pause":
          case "seek":
            handlersRef.current.onPlayback?.(
              msg.action,
              Number(msg.data.syncTimeMs) || 0,
              msg.timestamp,
            );
            break;
          case QUEUE_UPDATED:
            handlersRef.current.onQueueUpdated?.(
              msg.data.queue as QueueItem[] | undefined,
            );
            break;
          case STATE_UPDATED:
            handlersRef.current.onStateUpdated?.(
              msg.data.state as RoomState | undefined,
            );
            break;
          case "presence":
            handlersRef.current.onPresence?.(Number(msg.data.count) || 0);
            break;
          case "kicked":
            if (msg.data.userID === userID) handlersRef.current.onKicked?.();
            break;
        }
      };

      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (closed) return;
        setConn("closed");
        // Exponential backoff with jitter, so a room full of listeners doesn't
        // reconnect in lockstep and stampede the server the moment it returns.
        const delay = Math.min(
          RECONNECT_MIN_MS * 2 ** attempts,
          RECONNECT_MAX_MS,
        );
        attempts += 1;
        reconnectTimer = setTimeout(connect, delay * (0.7 + Math.random() * 0.6));
      };
      ws.onerror = () => ws.close();
    };

    connect();

    // Browsers freeze timers in background tabs, so a phone coming out of sleep
    // can sit on a dead socket well past its backoff. Nudge it on the signals
    // that say we're live again.
    const wakeUp = () => {
      if (closed || document.visibilityState === "hidden") return;
      const ws = socketRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
        return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      attempts = 0;
      connect();
    };
    document.addEventListener("visibilitychange", wakeUp);
    window.addEventListener("online", wakeUp);

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", wakeUp);
      window.removeEventListener("online", wakeUp);
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, [roomID, userID]);

  const send = useCallback((event: WSEvent) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }, []);

  const sendPlayback = useCallback(
    (action: PlaybackAction, syncTimeMs: number) =>
      send({ action, data: { syncTimeMs }, timestamp: 0 }),
    [send],
  );

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  return { conn, sendPlayback, serverNow };
}
