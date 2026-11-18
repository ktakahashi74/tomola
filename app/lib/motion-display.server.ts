import { and, inArray, isNull } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { media } from "./db/schema";
import { MEDIA_LIMITS, parseMediaImage } from "./media";
import { siteUrl } from "./site-url";
import { m } from "~/paraglide/messages.js";

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// These are complete sanitized tags, not a search for an img inside alt text.
const pairs = /<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>\s*<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>\s*<\/a>/gi;
const imageTag = /<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1] ?? "";
function path(value: string) {
  let origin: string | null = null;
  try { origin = new URL(siteUrl()).origin; } catch { /* Relative URLs work without an origin. */ }
  return parseMediaImage(value, origin);
}
export function motionCandidates(html: string) {
  return [...html.matchAll(pairs)].flatMap(match => {
    const image = match[0].match(imageTag)?.[0];
    const motion = path(attribute(match[0], "href")), still = image && path(attribute(image, "src"));
    return motion && still ? [{ motion, still }] : [];
  });
}
type Image = { id: string; width: number; height: number; animated: boolean; uploadedBy: string };
export function decorateMotionHtml(html: string, original: string, authorId: string, images: ReadonlyMap<string, Image>, interactive = true) {
  const valid = (motion: ReturnType<typeof path>, still: ReturnType<typeof path>) => {
    const a = motion && images.get(motion.id), b = still && images.get(still.id);
    return a?.animated && !b?.animated && b && a.uploadedBy === authorId && a.width === motion!.width && a.height === motion!.height && b.width === still!.width && b.height === still!.height;
  };
  const authored = new Set(motionCandidates(original).filter(pair => valid(pair.motion, pair.still)).map(pair => `${pair.motion.id}:${pair.still.id}`));
  let shown = 0;
  const stillImage = (raw: string) => {
    const parsed = path(attribute(raw, "src"));
    if (parsed && (images.get(parsed.id)?.animated || shown >= MEDIA_LIMITS.perPost)) return escape(attribute(raw, "alt") || m.motion_show());
    shown++;
    return raw;
  };
  return html.replace(new RegExp(`${pairs.source}|${imageTag.source}`, "gi"), raw => {
    if (/^<img\b/i.test(raw)) return stillImage(raw);
    const image = raw.match(imageTag)?.[0], motion = path(attribute(raw, "href")), still = image && path(attribute(image, "src"));
    if (!image || !motion || !still || !valid(motion, still) || !authored.has(`${motion.id}:${still.id}`)) return raw.replace(imageTag, stillImage);
    // Keep the established display cap: a still and its motion each use a slot.
    if (shown + 2 > MEDIA_LIMITS.perPost) return raw.replace(imageTag, tag => escape(attribute(tag, "alt")));
    shown += 2;
    const url = `/media/${motion.id}-${motion.width}x${motion.height}.webp`;
    return `<span class="inline-block max-w-full" data-motion-figure>${image}<span class="block ui-meta"><a href="${url}" ${interactive ? "data-motion-open" : ""} data-motion-back="${escape(m.motion_show_still())}">${escape(m.motion_show())}</a></span><span class="block ui-meta" data-motion-note hidden role="status">${escape(m.motion_original_text())}</span></span>`;
  });
}
export async function motionImages(db: Db, html: string[]) {
  const ids = [...new Set(html.flatMap(value => [...value.matchAll(/\/media\/([a-f0-9]{64})-/g)].map(match => match[1])))];
  const rows = ids.length ? await db.select({ id: media.id, width: media.width, height: media.height, animated: media.animated, uploadedBy: media.uploadedBy }).from(media).where(and(inArray(media.id, ids), isNull(media.deletedAt))) : [];
  return new Map(rows.map(row => [row.id, row]));
}
