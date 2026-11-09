// The isolated decoder also imports this module directly through Node.
import { LANGS, type Lang } from "./languages.ts";

export const MEDIA_LIMITS = {
  inputBytes: 10 * 1024 * 1024,
  requestBytes: 10 * 1024 * 1024 + 64 * 1024,
  pixels: 40_000_000,
  edge: 2000,
  storedBytes: 2 * 1024 * 1024,
  hourly: 30,
  memberReadsHourly: 6000,
  anonymousReadsHourly: 3000,
  readWindowSeconds: 3600,
  storedCount: 300,
  memberStoredBytes: 100 * 1024 * 1024,
  siteStoredBytes: 10 * 1024 * 1024 * 1024,
  perPost: 30,
  processingMs: 10_000,
  decoderRssBytes: 512 * 1024 * 1024,
  decoderPollMs: 25,
  receivingMs: 20_000,
  concurrent: 2,
  // Request bodies being received at once: each may hold requestBytes until it completes or times out.
  receiving: 8,
  receivingPerMember: 3,
} as const;

export type MediaErrorCode = "too_large" | "type" | "rate" | "quota" | "member_bytes" | "site_bytes" | "generic";
export class MediaError extends Error {
  code: MediaErrorCode;
  status: number;
  constructor(code: MediaErrorCode, status = 400) { super(`media ${code}`); this.code = code; this.status = status; }
}
export function mediaPath(id: string, width: number, height: number): string {
  return `/media/${id}-${width}x${height}.webp`;
}
export function parseMediaPath(path: string): { id: string; width: number; height: number } | null {
  const match = /^\/media\/([a-f0-9]{64})-([1-9]\d{0,3})x([1-9]\d{0,3})\.webp$/.exec(path);
  if (!match) return null;
  const width = Number(match[2]), height = Number(match[3]);
  return width <= MEDIA_LIMITS.edge && height <= MEDIA_LIMITS.edge ? { id: match[1], width, height } : null;
}

export function parseTranslatedMediaPath(path: string): { id: string; width: number; height: number; lang: Lang; version: number } | null {
  const match = /^(\/media\/[a-f0-9]{64}-[1-9]\d{0,3}x[1-9]\d{0,3})\.([a-zA-Z-]+)\.v([1-9]\d{0,5})\.webp$/.exec(path);
  if (!match || !(LANGS as readonly string[]).includes(match[2])) return null;
  const original = parseMediaPath(`${match[1]}.webp`);
  return original ? { ...original, lang: match[2] as Lang, version: Number(match[3]) } : null;
}

// Image Markdown and display decoration share the same managed-source rule.
export function parseMediaImage(src: string, origin: string | null) {
  if (src.startsWith("/")) return parseMediaPath(src);
  if (!origin) return null;
  try {
    const absolute = /^https?:\/\/[^/?#]+(\/.*)$/i.exec(src);
    if (!absolute) return null;
    const url = new URL(src);
    return url.origin === origin && !url.search && !url.hash ? parseMediaPath(absolute[1]) : null;
  } catch { return null; }
}
