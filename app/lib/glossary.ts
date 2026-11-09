// Browser-compatible glossary types and pure functions. Server reads/writes are in glossary.server.ts.

// Entry contents retained in history. Omit source/target languages because they are immutable after creation (lang_fixed in glossary.server.ts).
// needsReview means target-language speakers have not verified it. Excluded from glossary versions, but included in history to retain editor/time.
export type GlossaryContent = { term: string; candidates: string[]; note: string; keepOriginal: boolean; needsReview: boolean };

// Derive change kind instead of storing a column: null before means creation (including restoration); null after means deletion; both present mean modification.
export type GlossaryChangeKind = "created" | "updated" | "deleted";

export function glossaryChangeKind(rev: { before: unknown | null; after: unknown | null }): GlossaryChangeKind {
  if (rev.before === null || rev.before === undefined) return "created";
  if (rev.after === null || rev.after === undefined) return "deleted";
  return "updated";
}

// A change whose only difference is that needs_review went from true to false (a single save on the screen or the bulk "mark as reviewed"): /glossary labels it "marked as reviewed".
export function isReviewMark(before: GlossaryContent | null, after: GlossaryContent | null): boolean {
  return (
    before !== null &&
    after !== null &&
    before.needsReview &&
    !after.needsReview &&
    before.term === after.term &&
    before.note === after.note &&
    before.keepOriginal === after.keepOriginal &&
    before.candidates.length === after.candidates.length &&
    before.candidates.every((c, i) => c === after.candidates[i])
  );
}

// Change source: admin for /admin/glossary UI; import for pnpm glossary:import. Imports do not silently overwrite manually edited rows (glossary-io.server.ts),
// so retain the source of the latest change.
export const GLOSSARY_VIAS = ["admin", "import"] as const;
export type GlossaryVia = (typeof GLOSSARY_VIAS)[number];

// Entries per listing page.
export const GLOSSARY_PAGE_SIZE = 100;
// The number of changes shown under an entry on the page (newest first); "show all" lists the rest.
export const HISTORY_SHOWN = 20;

// A term and a candidate are one line of text: no control character (C0, DEL, C1), no line or paragraph separator. A newline in a term would let it start a
// Markdown block in a proposal template, and the list pages show a candidate as one line. Notes may contain line breaks and are not checked.
export const SINGLE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/;
export const isSingleLine = (text: string): boolean => SINGLE_LINE.test(text);
