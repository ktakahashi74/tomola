// Format characters that a human reader cannot see but a program reads: a short, fixed list of rules whose match is a
// candidate for a person to check. A match is not an attack finding and not a rule violation, and the absence of a match
// does not mean the text is safe. Nothing here is stored; callers decide each time from the original title and body.
//
// Only two rules exist. Other format characters are deliberately not judged: zero width non-joiner and joiner (Persian,
// Hindi, emoji sequences), the zero width space U+200B (Thai and Khmer word breaks), U+2060..U+2064 (word joiner and
// invisible math operators), U+180E (Mongolian), variation selectors, the Hangul fillers, and the plain marks U+200E and
// U+200F (they are in ordinary mixed-direction text). Unusual format characters in English prose are not treated as anomalies.
//
// Ranges are fixed by code point. Which characters Unicode has assigned is left to the runtime; the ranges here do not change with it.

export const UNICODE_REVIEW_REASONS = ["bidi_control", "tag_characters"] as const;
export type UnicodeReviewReason = (typeof UNICODE_REVIEW_REASONS)[number];
export type UnicodeReviewCounts = Partial<Record<UnicodeReviewReason, number>>;

// bidi_control: embeddings and overrides (U+202A..U+202E: LRE, RLE, PDF, LRO, RLO) and isolates (U+2066..U+2069: LRI, RLI, FSI, PDI).
// They are also used legitimately in quotations and mixed-direction sentences, so a match is a candidate, not a violation.
const BIDI_CONTROL = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

// tag_characters: the Unicode tag block U+E0000..U+E007F. It can carry text that is invisible on screen. Its one legitimate use is the
// emoji tag sequence of a region flag: the black flag U+1F3F4, the tag letters of a subdivision code, the cancel tag U+E007F.
// Only the three sequences that are drawn as an emoji flag (the RGI ones) are exempt: England (gbeng), Scotland (gbsct) and Wales (gbwls).
// Any other run of tag characters is counted even when it is shaped like a flag: otherwise a hidden sentence could be cut into flag-shaped
// pieces and count as zero. The exemption is exact (and as many times as they occur), not a pattern.
const tagLetters = (code: string) => [...code].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
const FLAG_SEQUENCE = new RegExp(`\u{1F3F4}(?:${["gbeng", "gbsct", "gbwls"].map(tagLetters).join("|")})\u{E007F}`, "gu");
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;

// Count in code points (a regular expression with the u flag matches one code point at a time), not UTF-16 units.
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

// Per reason, how many characters matched. Reasons with no match are absent.
export function unicodeReviewCounts(...texts: ReadonlyArray<string | null | undefined>): UnicodeReviewCounts {
  let bidi = 0;
  let tags = 0;
  for (const text of texts) {
    if (!text) continue;
    bidi += count(text, BIDI_CONTROL);
    tags += count(text.replace(FLAG_SEQUENCE, ""), TAG_CHARACTERS);
  }
  return { ...(bidi > 0 ? { bidi_control: bidi } : {}), ...(tags > 0 ? { tag_characters: tags } : {}) };
}

// The matched reasons, in a fixed order, for a frontmatter list.
export function unicodeReviewReasons(counts: UnicodeReviewCounts): UnicodeReviewReason[] {
  return UNICODE_REVIEW_REASONS.filter((reason) => (counts[reason] ?? 0) > 0);
}

// The moderator list reads the posts of the last 30 days, 500 rows per request, and shows 50 matches per request (lib/unicode-review-list.server.ts).
// The numbers are here, in code the screen may import, so that the page can state them.
export const UNICODE_REVIEW_DAYS = 30;
export const UNICODE_REVIEW_PAGE_SIZE = 50;
export const UNICODE_REVIEW_SCAN_LIMIT = 500;
