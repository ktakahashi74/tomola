import { firstBlockPlainText, truncateGraphemes } from "~/lib/plain-text.core.server";

// The one line that stands for a topic without a title: the beginning of its body, as plain text. Notifications, mails, search, lists, the thread page
// and the Markdown twins use it, so there is one rule. The Markdown is turned into text by the one plain-text implementation of the site (app/lib/plain-text.server.ts, shared
// with the excerpts of search, objections, mails and drafts); this file only decides which part of the post is the headline and how long it is.
// Server-only (the name ends in .server, because the plain-text implementation uses remark): a route uses it in its loader, never in the component. A client component that
// needs a limit takes it from the loader's data.

// How many characters (grapheme clusters) of the body the line keeps.
export const HEADLINE_CHARS = 80;

// The beginning of a body (Markdown) as one line of plain text: the first block that has any text (the first paragraph, with its line breaks as spaces, heading, list item or table row;
// the first line of a code block), with Markdown, link addresses, code fences and math markup removed (links and images keep their text), white space collapsed, and cut at `max` characters
// (grapheme clusters) with "…" (and at 4 times that in UTF-16 code units, against runs of combining marks). Control characters and bidi controls are removed, and a block that shows nothing
// (only zero width characters, for example) does not count as text. A body that is only a formula gives the first line of the formula. An empty string means there is no text at all (for example an image without alt
// text). The front matter is not part of a body (it is taken off before storing).
export function headlineFromBody(markdown: string, max: number = HEADLINE_CHARS): string {
  // The length is also bounded in UTF-16 code units (4 characters' worth for each allowed one), because a run of combining marks is one grapheme however long it is.
  return truncateGraphemes(firstBlockPlainText(markdown), max, { trimEnd: true, maxUnits: Math.max(max, HEADLINE_CHARS) * 4 });
}
