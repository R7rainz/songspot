import type { Song } from "./types";

/** Extract an 11-char YouTube video id from a URL or a raw id. */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.slice(1);
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const parts = url.pathname.split("/"); // /embed/ID or /shorts/ID
      const last = parts[parts.length - 1];
      if (/^[a-zA-Z0-9_-]{11}$/.test(last)) return last;
    }
  } catch {
    // not a URL
  }
  return null;
}

export function thumbnailFor(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/**
 * Build a Song from a video id. Duration isn't available without the YouTube
 * Data API (not wired yet), so it's left at 0 and shown as "live length" in the
 * UI. Title comes from YouTube's public oEmbed endpoint, with a graceful
 * fallback if it's unreachable.
 */
export async function songFromId(id: string): Promise<Song> {
  const base: Song = {
    id,
    title: `Video ${id}`,
    duration: 0,
    thumbnail: thumbnailFor(id),
  };
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${id}`,
      )}`,
    );
    if (!res.ok) return base;
    const data = (await res.json()) as { title?: string };
    if (data.title) base.title = data.title;
  } catch {
    // oEmbed blocked or offline — keep the fallback title.
  }
  return base;
}

export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor(totalSeconds / 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
