// The syntax of an @mention in a post body. Pure text rules, no dependencies: the server (parsing, rendering, notifications, the translation check)
// and the browser (the handle suggestions in the posting textareas) share them.
//
// A mention is a sigil (@, or the full-width ＠ that Japanese input produces) followed by a handle. The handle rules are those of profiles.server.ts (handleSchema):
// the first character is an ASCII lowercase letter or a digit, the rest also allow _ and -, at most 30 characters (2 or more). Input characters are checked after NFKC and lowercasing. Whether a mention names a member is decided
// elsewhere (mentions-md.server.ts), by the longest prefix of the character run that is the handle of an existing member.

// NFKC turns ＠ into @, so both are the same sigil.
export const MENTION_SIGILS = ["@", "＠"] as const;
export const isMentionSigil = (ch: string): boolean => (MENTION_SIGILS as readonly string[]).includes(ch);
// The same character classes as handleSchema in profiles.server.ts. The first character is a letter or a digit.
export const HANDLE_FIRST = /^[a-z0-9]$/;
export const HANDLE_REST = /^[a-z0-9_-]$/;
export const MIN_HANDLE_LENGTH = 2;
export const MAX_HANDLE_LENGTH = 30;
// A character that must not come right before a sigil (the local part of an e-mail address, the middle of an ASCII word). A sigil right after Japanese or other
// non-ASCII text is a mention: Japanese is written without spaces.
export const BLOCKED_BEFORE_SIGIL = /[A-Za-z0-9_.+\-@＠]/;

export type MentionCandidate = {
  // Index of the sigil in the text, and the index just after the run of handle characters (UTF-16 units, like String.prototype.slice).
  start: number;
  end: number;
  // The run of handle characters after the sigil (2 to 30 characters). It may be longer than the handle it names: "@hana-san" may name "hana".
  token: string;
};

// The code point that ends just before `index` (a surrogate pair is one character).
function charBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1];
}

// The run of handle characters that starts at `from` (0 to 30 characters, the first one a letter or a digit). Returns the end index and the number of characters.
function handleRun(text: string, from: number): { end: number; length: number } {
  let end = from;
  let length = 0;
  while (end < text.length && length < MAX_HANDLE_LENGTH) {
    const ch = String.fromCodePoint(text.codePointAt(end)!);
    if (!(length === 0 ? HANDLE_FIRST : HANDLE_REST).test(ch.normalize("NFKC").toLowerCase())) break;
    end += ch.length;
    length++;
  }
  return { end, length };
}

// Candidate mentions in a piece of text, in order. A sigil directly after BLOCKED_BEFORE_SIGIL is skipped ("a@b.com", "x@hana"); a run shorter than 2 characters is skipped.
export function mentionCandidates(text: string): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  let i = 0;
  while (i < text.length) {
    const sigil = text[i];
    if (!isMentionSigil(sigil)) {
      i++;
      continue;
    }
    const before = charBefore(text, i);
    if (before !== "" && BLOCKED_BEFORE_SIGIL.test(before)) {
      i++;
      continue;
    }
    const run = handleRun(text, i + 1);
    if (run.length < MIN_HANDLE_LENGTH) {
      i++;
      continue;
    }
    out.push({ start: i, end: run.end, token: text.slice(i + 1, run.end) });
    i = run.end;
  }
  return out;
}

// The prefixes of a candidate's ASCII run, longest first, 2 characters or more. A trailing _ or - can belong to prose rather than the handle, so shorter prefixes are still tried.
export function tokenPrefixes(token: string): string[] {
  const chars = Array.from(token);
  const out: string[] = [];
  for (let n = Math.min(chars.length, MAX_HANDLE_LENGTH); n >= MIN_HANDLE_LENGTH; n--) {
    out.push(chars.slice(0, n).join(""));
  }
  return out;
}

// Only the resolved source mentions are names that the translation must keep. An unresolved candidate, or the Japanese text after a handle, remains content.
export function withoutResolvedMentions(text: string, mentions: readonly string[] = []): string {
  if (mentions.length === 0) return text;
  const known = new Set(mentions.map((m) => m.slice(1).normalize("NFKC").toLowerCase()));
  const found = mentionCandidates(text);
  if (found.length === 0) return text;
  let out = "";
  let at = 0;
  for (const c of found) {
    const prefix = tokenPrefixes(c.token).find((p) => known.has(p.normalize("NFKC").toLowerCase()));
    if (prefix === undefined) continue;
    out += text.slice(at, c.start);
    at = c.start + 1 + prefix.length;
  }
  return out + text.slice(at);
}

// The mention being typed at the end of `textBeforeCursor` (the textarea's text up to the cursor): the index of its sigil and the run after it (1 to 30 handle characters).
// A cursor right after a bare sigil is not a query yet. Used by the suggestion component and the suggestion endpoint's input check.
export function mentionQueryAt(textBeforeCursor: string): { start: number; query: string } | null {
  let i = textBeforeCursor.length;
  let count = 0;
  while (i > 0 && count <= MAX_HANDLE_LENGTH) {
    const ch = charBefore(textBeforeCursor, i);
    if (isMentionSigil(ch)) {
      if (count < 1) return null;
      const sigilAt = i - ch.length;
      const before = charBefore(textBeforeCursor, sigilAt);
      if (before !== "" && BLOCKED_BEFORE_SIGIL.test(before)) return null;
      const query = textBeforeCursor.slice(i);
      return HANDLE_FIRST.test(String.fromCodePoint(query.codePointAt(0)!).normalize("NFKC").toLowerCase()) ? { start: sigilAt, query } : null;
    }
    if (!HANDLE_REST.test(ch.normalize("NFKC").toLowerCase())) return null;
    i -= ch.length;
    count++;
  }
  return null;
}

// Is an already normalized `q` a well-formed query for the suggestion endpoint: 1 to 30 ASCII handle characters, the first a lowercase letter or a digit.
export function isMentionQuery(q: string): boolean {
  const chars = Array.from(q);
  return chars.length >= 1 && chars.length <= MAX_HANDLE_LENGTH && HANDLE_FIRST.test(chars[0]) && chars.every((c) => HANDLE_REST.test(c));
}
