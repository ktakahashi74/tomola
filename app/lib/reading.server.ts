import type { EntryDisplay } from "~/lib/entry-display.server";
import type { ReadingInfo, ReadingVersions } from "~/lib/reading";

// Read only our serialized, sanitized body HTML. React escapes the extracted text
// when it displays the table of contents; it is never inserted as HTML.
function textOf(html: string): string {
  return html
    .replace(/<span class="katex-mathml">[\s\S]*?<\/math><\/span>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
      if (entity[0] === "#") {
        const point = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "";
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()];
    });
}

// The serializer quotes attribute values but leaves "<" and ">" literal inside them, so a regex that
// treats every "<h2" as a tag start rescans the rest of the tag for each one (quadratic on a hostile
// link title). This walks the tags once instead, skipping quoted values, in time linear in the input.
const TAG_START = /<\/?[a-z]/iy;
const HEADING_TAG = /^<(\/?)(h[23])(?![\w:-])/;
const ATTRIBUTE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s"'<>]*))?/g;
const HEADING_ID = /^[a-z0-9-]+h-\d+$/;

// Index just past the ">" that ends the tag opening at `from`, or -1 when it is not closed.
function tagEnd(html: string, from: number): number {
  let quote = "";
  for (let i = from + 1; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i + 1;
    }
  }
  return -1;
}

function headingId(tag: string): string | null {
  for (const attribute of tag.matchAll(ATTRIBUTE)) {
    if (attribute[1] === "id") return attribute[2] !== undefined && HEADING_ID.test(attribute[2]) ? attribute[2] : null;
  }
  return null;
}

function extractHeadings(html: string): ReadingInfo["headings"] {
  const headings: ReadingInfo["headings"] = [];
  let open: { id: string; name: string; contentStart: number } | null = null;
  let position = 0;
  while ((position = html.indexOf("<", position)) !== -1) {
    // A "<" that does not start a tag name is plain text; it must not open a quote scan.
    TAG_START.lastIndex = position;
    if (!TAG_START.test(html)) {
      position += 1;
      continue;
    }
    const end = tagEnd(html, position);
    if (end < 0) break;
    const tag = html.slice(position, end);
    const heading = HEADING_TAG.exec(tag);
    if (heading) {
      if (open && heading[1] && heading[2] === open.name) {
        headings.push({ id: open.id, depth: Number(open.name[1]) as 2 | 3, text: textOf(html.slice(open.contentStart, position)).replace(/\s+/g, " ").trim() });
        open = null;
      } else if (!open && !heading[1]) {
        const id = headingId(tag);
        if (id) open = { id, name: heading[2], contentStart: end };
      }
    }
    position = end;
  }
  return headings;
}

export function readingInfo(html: string, lang: string): ReadingInfo {
  const headings = extractHeadings(html);
  // Preserve inline word boundaries while separating adjacent blocks.
  const text = textOf(html.replace(/<\/?(?:p|h[1-6]|li|pre|blockquote|tr|td|th|br|section)\b[^>]*>/g, " ")).trim();
  const cjk = /^(?:ja|zh|ko)(?:-|$)/i.test(lang);
  const units = cjk ? Array.from(text.replace(/\s/g, "")).length : (text.match(/\S+/g)?.length ?? 0);
  return { headings, minutes: Math.ceil(units / (cjk ? 500 : 220)) };
}

export function readingVersions(html: string, lang: string, display: EntryDisplay): ReadingVersions {
  const tr = display.translation;
  return {
    original: readingInfo(html, lang),
    translation: tr ? readingInfo(tr.html, tr.lang) : null,
    older: tr?.older?.html != null ? readingInfo(tr.older.html, tr.lang) : null,
  };
}
