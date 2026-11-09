import { markdownTask, MarkdownBudgetError, isMarkdownWrite } from "./markdown-budget.server";
import { AI_ASSISTANCE, type AiAssistance } from "~/lib/ai-assistance";
import { isLang, type Lang } from "~/lib/languages";
import { isStanceTag, type StanceTag } from "~/lib/stances";
import { villagesEnabled } from "~/lib/villages-enabled.server";

// Read entry frontmatter in the same shape as Markdown frontmatter. Used in POST /api/drafts bodies and at the start of Markdown pasted
// into new-topic/reply forms. If the body starts with a 「---」 line and closes with a later 「---」 or 「...」 line, parse the intervening text as YAML.
//
// Accept only YAML 1.2 core-schema maps (no aliases such as *a, duplicate keys, or custom tags; up to 32 KiB). Parsed values are
// untrusted declarations before entry validation.

// Maximum frontmatter length in characters. Prevent huge nesting and similar input from consuming parsing time/depth.
export { MAX_FRONTMATTER_LENGTH } from "./entry-frontmatter-types";
import { MAX_FRONTMATTER_LENGTH } from "./entry-frontmatter-types";

export type Split = { found: false } | { found: true; raw: string; body: string; closed: boolean };

// Extract leading frontmatter. Return found: false unless the first line, ignoring BOM, is exactly 「---」. Return closed: false without a closing line.
export function splitFrontmatter(text: string): Split {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const open = /^---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!open) return { found: false };
  const rest = source.slice(open[0].length);
  const close = /(?:^|\r?\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!close) return { found: true, raw: rest, body: "", closed: false };
  return { found: true, raw: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length), closed: true };
}

export { type MappingResult } from "./entry-frontmatter-types";
import type { MappingResult } from "./entry-frontmatter-types";

// Parse YAML text as a map; empty input becomes an empty map. Syntax errors yield invalid_frontmatter; non-map values (arrays, strings, etc.) yield frontmatter_not_object.
export async function parseMapping(raw: string): Promise<MappingResult> {
  if (raw.length > MAX_FRONTMATTER_LENGTH) return { ok: false, error: "invalid_frontmatter" };
  try { return await markdownTask("parseMapping", [raw]); }
  catch (error) {
    if (error instanceof MarkdownBudgetError && !isMarkdownWrite()) return { ok: false, error: "invalid_frontmatter" };
    throw error;
  }
}

export type FrontmatterError =
  | "village_required"
  | "unknown_type"
  | "reply_to_malformed"
  | "reply_to_on_topic"
  | "reply_to_required"
  | "invalid_title"
  | "invalid_lang"
  | "invalid_ai"
  // Stance-requesting topic attributes: asks_stance boolean, alt_of p-<id>, stance_tag agree | disagree | neither | objection. Kind mismatches
  // (asks_stance: true or alt_of on replies; stance_tag on topics) use the same error category.
  | "invalid_asks_stance"
  | "invalid_alt_of"
  | "invalid_stance_tag";

export type ReplyTarget = { kind: "topic" | "reply"; id: number };

export type Declared = {
  village?: string;
  // Kind determined by type/reply_to; topic if both are absent.
  kind: "topic" | "reply";
  // Explicit type if supplied, otherwise undefined. Used to detect kind mismatches in pasted-form input.
  explicitType?: "topic" | "reply";
  title?: string;
  lang?: Lang;
  aiAssistance?: AiAssistance;
  // Reply target: p-<id> for topics, c-<id> for replies.
  replyTo?: ReplyTarget;
  // Stance-requesting question status (topics only); original-question id for alternative framings (topics only, p-<id>); reply label (replies only).
  asksStance?: boolean;
  altOf?: number;
  stanceTag?: StanceTag;
};

const TYPES: Record<string, "topic" | "reply"> = { topic: "topic", post: "topic", reply: "reply", comment: "reply" };
const REPLY_TO = /^(p|c)-([1-9]\d{0,15})$/;
const ALT_OF = /^p-([1-9]\d{0,15})$/;

// Read map fields as declarations: type, title, lang, reply_to, ai_assistance, asks_stance, alt_of, stance_tag. Ignore other keys, including stance, which might attempt to specify the stance itself
// (stances can be written only through the browser's stance section, not the API). asks_stance accepts YAML booleans only, not string "true"; alt_of requires a p-<id> string; stance_tag accepts four values.
// type: topic | reply, also accepting Markdown's post | comment. Without type, reply_to implies a reply; otherwise a topic.
// Treat null fields as absent; pasting Markdown frontmatter unchanged includes reply_to: null.
// requireReplyTo defaults to true for API drafts: type reply without reply_to yields reply_to_required. Use false for pasted forms
// where an absent target in a reply form means replying to its topic, while reply kind in a topic form itself constitutes a mismatch.
export function interpretFrontmatter(
  data: Record<string, unknown>,
  opts: { requireReplyTo?: boolean } = {},
): { ok: true; declared: Declared } | { ok: false; error: FrontmatterError } {
  const get = (key: string) => (data[key] === null ? undefined : data[key]);

  const type = get("type");
  let explicit: "topic" | "reply" | undefined;
  if (type !== undefined) {
    const kind = typeof type === "string" ? TYPES[type] : undefined;
    if (!kind || !Object.hasOwn(TYPES, type as string)) return { ok: false, error: "unknown_type" };
    explicit = kind;
  }

  let replyTo: ReplyTarget | undefined;
  const rawReplyTo = get("reply_to");
  if (rawReplyTo !== undefined) {
    const m = typeof rawReplyTo === "string" ? REPLY_TO.exec(rawReplyTo.trim()) : null;
    if (!m) return { ok: false, error: "reply_to_malformed" };
    replyTo = { kind: m[1] === "p" ? "topic" : "reply", id: Number(m[2]) };
    if (!Number.isSafeInteger(replyTo.id)) return { ok: false, error: "reply_to_malformed" };
  }
  if (explicit === "topic" && replyTo) return { ok: false, error: "reply_to_on_topic" };
  if (explicit === "reply" && !replyTo && (opts.requireReplyTo ?? true)) return { ok: false, error: "reply_to_required" };

  const declared: Declared = { kind: explicit ?? (replyTo ? "reply" : "topic"), explicitType: explicit, replyTo };
  if (villagesEnabled() && get("village") !== undefined) {
    if (typeof get("village") !== "string" || !(get("village") as string).trim()) return { ok: false, error: "village_required" };
    declared.village = get("village") as string;
  }

  const title = get("title");
  if (title !== undefined) {
    if (typeof title === "string") declared.title = title;
    else if (typeof title === "number" || typeof title === "boolean") declared.title = String(title);
    else return { ok: false, error: "invalid_title" };
  }
  const lang = get("lang");
  if (lang !== undefined) {
    if (!isLang(lang)) return { ok: false, error: "invalid_lang" };
    declared.lang = lang;
  }
  const ai = get("ai_assistance");
  if (ai !== undefined) {
    if (typeof ai !== "string" || !(AI_ASSISTANCE as readonly string[]).includes(ai)) return { ok: false, error: "invalid_ai" };
    declared.aiAssistance = ai as AiAssistance;
  }
  const asks = get("asks_stance");
  if (asks !== undefined) {
    if (typeof asks !== "boolean") return { ok: false, error: "invalid_asks_stance" };
    declared.asksStance = asks;
  }
  const altOf = get("alt_of");
  if (altOf !== undefined) {
    const m = typeof altOf === "string" ? ALT_OF.exec(altOf.trim()) : null;
    if (!m || !Number.isSafeInteger(Number(m[1]))) return { ok: false, error: "invalid_alt_of" };
    declared.altOf = Number(m[1]);
  }
  const tag = get("stance_tag");
  if (tag !== undefined) {
    if (!isStanceTag(tag)) return { ok: false, error: "invalid_stance_tag" };
    declared.stanceTag = tag;
  }
  // Kind mismatches: replies cannot be questions/alternative framings, and topics cannot have reply labels. Check only when kind is known. API defaults to topic without type/reply_to; pasted forms
  // determine kind themselves, so leave it undecided here without type/reply_to. isKindMismatch checks against the form kind.
  const kindKnown = (opts.requireReplyTo ?? true) || explicit !== undefined || replyTo !== undefined;
  if (kindKnown) {
    if (declared.kind === "reply") {
      if (declared.asksStance === true) return { ok: false, error: "invalid_asks_stance" };
      if (declared.altOf !== undefined) return { ok: false, error: "invalid_alt_of" };
    } else if (declared.stanceTag !== undefined) {
      return { ok: false, error: "invalid_stance_tag" };
    }
  }
  return { ok: true, declared };
}

// Parse and remove frontmatter from the body. Without leading frontmatter (no initial --- line), leave it unchanged.
// - API (strict): error for unclosed, invalid YAML, or non-map frontmatter.
// - Pasted forms (non-strict): on parsing failure, retain the whole text as the body, as if it had no frontmatter.
// On success, body starts after the closing frontmatter line, dropping initial blank lines.
export type Extracted =
  | { ok: true; found: false; body: string }
  | { ok: true; found: true; raw: string; data: Record<string, unknown>; body: string }
  | { ok: false; error: "invalid_frontmatter" | "frontmatter_not_object" };

export async function extractFrontmatter(text: string, opts: { strict: boolean }): Promise<Extracted> {
  const split = splitFrontmatter(text);
  if (!split.found) return { ok: true, found: false, body: text };
  const fail = (error: "invalid_frontmatter" | "frontmatter_not_object"): Extracted => (opts.strict ? { ok: false, error } : { ok: true, found: false, body: text });
  if (!split.closed) return fail("invalid_frontmatter");
  const parsed = await parseMapping(split.raw);
  if (!parsed.ok) return fail(parsed.error);
  return { ok: true, found: true, raw: split.raw, data: parsed.data, body: split.body.replace(/^(?:\r?\n)+/, "") };
}

// Keys identifying pasted frontmatter. A map with none of the keys used by entry frontmatter, including Markdown frontmatter,
// is ordinary body text (such as headings 「Q: … / A: …」), preventing silent loss of content.
export const ENTRY_KEYS = ["type", "title", "lang", "reply_to", "ai_assistance", "asks_stance", "alt_of", "stance_tag", "id", "thread", "content_trust"] as const;

export function hasEntryKeys(data: Record<string, unknown>): boolean {
  return ENTRY_KEYS.some((key) => Object.hasOwn(data, key)) || (villagesEnabled() && Object.hasOwn(data, "village"));
}

// Leading frontmatter in pasted new-topic/reply bodies, with identical decisions for submission and preview: accept only a valid YAML map
// containing at least one entry key. Otherwise (unparseable, non-map, or no entry keys), return pasted: false
// with the body unchanged.
export type Pasted = { pasted: false } | { pasted: true; data: Record<string, unknown>; raw: string; body: string };

export async function extractPasted(text: string): Promise<Pasted> {
  const extracted = await extractFrontmatter(text, { strict: false });
  if (!extracted.ok || !extracted.found || !hasEntryKeys(extracted.data)) return { pasted: false };
  return { pasted: true, data: extracted.data, raw: extracted.raw, body: extracted.body };
}
