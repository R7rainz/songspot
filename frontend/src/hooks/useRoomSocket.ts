import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackAction, WSEvent } from "../lib/types";
import { QUEUE_UPDATED } from "../lib/types";

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
  onPlayback?: (action: PlaybackAction, syncTimeMs: number, serverTime: number) => void;
  onQueueUpdated?: () => void;
}

/**
 * Manages the room WebSocket: reconnection, a rolling clock-offset estimate via
 * ping/pong, and typed helpers for playback + queue-refetch broadcasts.
 * `offset` is (serverTime - clientTime); add it to Date.now() for server time.
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
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      setConn("connecting");
      const ws = new WebSocket(wsUrl(roomID, userID));
      socketRef.current = ws;

      ws.onopen = () => {
        setConn("open");
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
            handlersRef.current.onQueueUpdated?.();
            break;
        }
      };

      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (closed) return;
        setConn("closed");
        reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
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

  const notifyQueueChanged = useCallback(
    () => send({ action: QUEUE_UPDATED, data: {}, timestamp: 0 }),
    [send],
  );

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  return { conn, sendPlayback, notifyQueueChanged, serverNow };
}
