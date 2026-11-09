import { loadDisplayNames, selectDisplayName } from "./display-names.server";
import { authorLabel } from "./deleted-member";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { media } from "~/lib/db/schema";
import { loadPickedTranslations } from "~/lib/entry-display.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { headlineFromBody } from "~/lib/headline.server";
import { shareLanguageHint } from "~/lib/share-language";
import type { Lang } from "~/lib/languages";
import { canReadMedia } from "~/lib/media-references.server";
import { mediaPath } from "~/lib/media";
import { markdownToPlainText } from "~/lib/plain-text.server";
import { previewText } from "~/lib/share-text";
import type { ShareImage } from "~/lib/share-meta";
import { siteOrigin } from "~/lib/http/csrf.server";

// A topic's shared preview, made in its loader: Markdown cannot be read in the browser, so `meta` gets the result as loader data.

// The first image of a post that is one of the site's own (/media/<id>-<width>x<height>.webp, relative or on this site's origin). Images from elsewhere are shown as links, not images,
// so they are not previewed either.
//
// A body is written by a member and this runs on the main thread for every reader, so the time must grow with the length of the body and not faster. The address of the image is
// looked for first, in one pass with a regular expression that has no nested repetition (the same pattern the references of a post are found with). Only then is the short stretch of
// text before it looked at, backwards, to see that it is the end of `![alt](`. The stretch is at most LOOKBACK characters, and at most MAX_CANDIDATES addresses are tried, so a body
// made of thousands of "![" or of addresses remains bounded. An image whose opener is outside the stretch is skipped, since it cannot be distinguished from a long link.
const MEDIA_ADDRESS = /\/media\/([a-f0-9]{64})-([1-9]\d{0,3})x([1-9]\d{0,3})\.webp\b/g;
const LOOKBACK = 600;
const MAX_CANDIDATES = 50;

function escapedAt(text: string, index: number): boolean {
  let slashes = 0;
  while (index - 1 - slashes >= 0 && text[index - 1 - slashes] === "\\") slashes++;
  return slashes % 2 === 1;
}

// `before`: the text before an address, at most LOOKBACK characters of it. Returns the alt text of the image whose address follows, or null when
// what follows `before` is not the address of an image.
function altBefore(before: string, origin: string): string | null {
  let head = before;
  if (head.endsWith(origin)) head = head.slice(0, -origin.length);
  if (head.endsWith("<")) head = head.slice(0, -1);
  head = head.trimEnd();
  if (!head.endsWith("](")) return null;
  head = head.slice(0, -2);
  // Backwards to the "[" that opens the alt text; an unescaped "]" first means this is not the end of an image.
  for (let at = head.length - 1; at >= 0; at--) {
    const ch = head[at];
    if (ch !== "[" && ch !== "]") continue;
    if (escapedAt(head, at)) continue;
    if (ch === "]") return null;
    return at > 0 && head[at - 1] === "!" ? head.slice(at + 1) : null;
  }
  // No opener within reach: do not guess whether this was an image.
  return null;
}

export function firstMediaImage(markdown: string, origin: string = siteOrigin()): { id: string; alt: string } | null {
  let tried = 0;
  for (const match of markdown.matchAll(MEDIA_ADDRESS)) {
    if (tried++ >= MAX_CANDIDATES) return null;
    const start = Math.max(0, match.index - LOOKBACK);
    const alt = altBefore(markdown.slice(start, match.index), origin);
    if (alt === null) continue;
    return { id: match[1], alt: alt.replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim() };
  }
  return null;
}

// The image is previewed only if a reader who has not logged in is served it: it exists, was not deleted, is the size its address says, and is used by a post that is readable.
async function publicImage(db: Db, found: { id: string; alt: string }, origin: string): Promise<ShareImage | null> {
  const [row] = await db.select({ width: media.width, height: media.height }).from(media).where(and(eq(media.id, found.id), isNull(media.deletedAt)));
  if (!row || !await canReadMedia(db, found.id, null)) return null;
  return { url: `${origin}${mediaPath(found.id, row.width, row.height)}`, width: row.width, height: row.height, alt: found.alt };
}

export type TopicShare = { title: string; author: string | null; lang: Lang; description: string | null; image: ShareImage | null };

// For a topic everyone may read (checked by the caller). Explicit reading language, then preview hint, then source language; never reader preferences.
// The title and body must both be available in the requested language. The image is the first in the source, with that version's alt text when it has the same image.
export async function topicShare(db: Db, topic: { id: number; authorHandle?: string; lang: Lang; title: string | null; body: string; sourceHash: string | null }, search: string): Promise<TopicShare> {
  const origin = siteOrigin();
  let markdown = topic.body;
  let lang = topic.lang;
  let title = topic.title;
  const requested = shareLanguageHint(search, enabledLangs())?.lang ?? topic.lang;
  if (requested !== topic.lang) {
    const rows = (await loadPickedTranslations(db, [{ id: topic.id, kind: "topic", lang: topic.lang, sourceHash: topic.sourceHash }], requested, topic.title === null ? ["body"] : ["title", "body"])).get(topic.id);
    if (rows?.body && (topic.title === null || rows.title)) {
      markdown = rows.body.text;
      title = topic.title === null ? null : rows.title!.text;
      lang = requested;
    }
  }
  const description = previewText(await markdownToPlainText(markdown), lang);
  const cardTitle = title ?? await headlineFromBody(markdown);
  const original = firstMediaImage(topic.body, origin);
  const shown = original && markdown !== topic.body ? firstMediaImage(markdown, origin) : null;
  const image = original ? await publicImage(db, { id: original.id, alt: lang === topic.lang ? original.alt : shown?.id === original.id ? shown.alt : cardTitle }, origin) : null;
  const names = await loadDisplayNames(db, [topic.authorHandle ?? null]);
  const author = topic.authorHandle ? selectDisplayName(names.get(topic.authorHandle), lang) ?? authorLabel(topic.authorHandle) : null;
  return { title: cardTitle, author, lang, description: description === "" ? null : description, image };
}
