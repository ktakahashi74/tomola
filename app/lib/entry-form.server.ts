import { MarkdownBudgetError, withMarkdownRead } from "./markdown-budget.server";
import type { AiAssistance } from "~/lib/ai-assistance";
import type { SessionUser } from "~/lib/auth/session.server";
import type { Db } from "~/lib/db/client.server";
import { createTopic, type EntryError } from "~/lib/entries.server";
import { extractPasted, interpretFrontmatter, type Declared } from "~/lib/entry-frontmatter.server";
import { defaultPostLang, type Profile } from "~/lib/profiles.server";
import { resolvePostLanguage, type LanguageDecision } from "~/lib/lang-detect";
import { normalizeNewlines } from "~/lib/text";
import { villagesEnabled } from "~/lib/villages-enabled.server";

export function formString(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}

// Absent preserves pasted frontmatter; an explicit empty value means the topic.
export function readReplyParent(form: FormData): number | null | undefined {
  if (!form.has("parentId")) return undefined;
  const value = formString(form, "parentId").trim();
  return value === "" ? null : Number(value);
}

// Convert web-form input for entry/draft services. Normalize title/body newlines to LF.
// No validation here; services validate. Absent form fields become empty strings or defaults.
// Question attributes: asksStance is the 「立場を聞く」 checkbox (true only for "1"); altOf is the hidden alternative-framing field from /t/new?alt_of=… (empty means null;
// nonnumeric values become NaN for service rejection as invalid_alt_of). stanceTag is the reply-label choice; empty means 「選ばない」 and null. Services validate values.
// The form has no AI-assistance field: the value comes only from pasted frontmatter (applyPastedFrontmatter) or the API.
export function readEntryForm(form: FormData) {
  const altOf = formString(form, "altOf").trim();
  const stanceTag = formString(form, "stanceTag").trim();
  return {
    ...(villagesEnabled() && form.has("village") ? { village: formString(form, "village") } : {}),
    ...(villagesEnabled() && form.has("villageExplicit") ? { villageExplicit: formString(form, "villageExplicit") === "1" } : {}),
    ...(villagesEnabled() && form.has("villageDisplayed") ? { villageDisplayed: formString(form, "villageDisplayed") } : {}),
    title: normalizeNewlines(formString(form, "title")),
    body: normalizeNewlines(formString(form, "body")),
    lang: formString(form, "lang"),
    asksStance: formString(form, "asksStance") === "1",
    altOf: altOf === "" ? null : Number(altOf),
    stanceTag: stanceTag === "" ? null : stanceTag,
  };
}

// Read leading frontmatter in Markdown pasted into new-topic/reply forms at submission.
// On success, extract title, language, optional ai_assistance, and reply target; remove frontmatter from the body. On failure (not a YAML map, unclosed, etc.),
// treat the entire text as the body. Maps with none of the entry keys (type, title, lang, reply_to, ai_assistance, id, thread, content_trust)
// are also ordinary body text, avoiding silently dropping text such as 「Q: … / A: …」 (extractPasted).
//
// Explicit form values override frontmatter. Use the frontmatter title only when the form's title field is empty.
// For 「自動」 (empty, the form default), use the frontmatter language, otherwise detect the body language and fall back to the default when detection is inconclusive or disabled. ai_assistance uses frontmatter if present, otherwise null, not 「なし」.
// Question attributes: a checked 「立場を聞く」 means true; otherwise use frontmatter asks_stance or false. For alt_of, the hidden form value takes precedence,
// followed by frontmatter. The selected reply-label form value wins; use frontmatter if empty.
// Only reply forms use reply_to. A reply within this topic becomes a reply-to-reply; a topic target or absent target means a reply to the topic.
export type PastedError = "frontmatter_invalid" | "frontmatter_type_mismatch" | "body_too_complex" | "village_required";

// What the form states, plus the optional ai_assistance that only frontmatter can carry (null: not stated).
export type EntryFormInput = ReturnType<typeof readEntryForm> & { aiAssistance: AiAssistance | null; langCode?: string | null; langSource?: string };

export type PastedResult =
  | { ok: true; input: EntryFormInput; language: LanguageDecision; parentId?: number }
  | { ok: false; error: PastedError };

// Kind mismatches the form: reply frontmatter in a topic form or topic frontmatter in a reply form. Also used by preview.
// Question attributes also mismatch when incompatible with the kind: asks_stance: true/alt_of in a reply form, or stance_tag in a topic form.
export function isKindMismatch(declared: Declared, kind: "topic" | "reply"): boolean {
  if (kind === "topic") return declared.kind === "reply" || declared.stanceTag !== undefined;
  return declared.explicitType === "topic" || declared.asksStance === true || declared.altOf !== undefined;
}

export async function applyPastedFrontmatter(
  input: ReturnType<typeof readEntryForm>,
  kind: "topic" | "reply",
  opts: { defaultLang: string; threadId?: number; parentId?: number | null; allowComplex?: boolean },
): Promise<PastedResult> {
  let extracted;
  try { extracted = await (opts.allowComplex ? withMarkdownRead(async () => (await extractPasted(input.body))) : (await extractPasted(input.body))); }
  catch (error) { if (error instanceof MarkdownBudgetError) return { ok: false, error: "body_too_complex" }; throw error; }
  const resolve = async (body: string, explicit: string | undefined) => {
    try { return await (opts.allowComplex ? withMarkdownRead(() => resolvePostLanguage(body, explicit, opts.defaultLang)) : resolvePostLanguage(body, explicit, opts.defaultLang)); }
    catch (error) { if (error instanceof MarkdownBudgetError) return { error: "body_too_complex" as const }; throw error; }
  };
  if (!extracted.pasted) {
    const resolved = (await resolve(input.body, input.lang));
    if ("error" in resolved) return { ok: false, error: resolved.error! };
    return { ok: true, input: { ...input, ...(input.villageExplicit === false ? { village: undefined } : {}), lang: resolved.lang, langCode: resolved.langCode, langSource: resolved.langSource, aiAssistance: null }, language: resolved.language, parentId: opts.parentId ?? undefined };
  }
  const interpreted = interpretFrontmatter(extracted.data, { requireReplyTo: false });
  if (!interpreted.ok) return { ok: false, error: interpreted.error === "village_required" ? "village_required" : "frontmatter_invalid" };
  const declared = interpreted.declared;
  if (isKindMismatch(declared, kind)) return { ok: false, error: "frontmatter_type_mismatch" };
  let parentId: number | undefined = opts.parentId ?? undefined;
  if (kind === "reply" && opts.parentId === undefined && declared.replyTo) {
    // A topic (p-<id>) is within this thread only if it is this thread's topic; other topics are outside.
    if (declared.replyTo.kind === "topic") {
      if (declared.replyTo.id !== opts.threadId) return { ok: false, error: "frontmatter_invalid" };
    } else {
      parentId = declared.replyTo.id;
    }
  }
  const resolved = (await resolve(extracted.body, input.lang || declared.lang));
  if ("error" in resolved) return { ok: false, error: resolved.error! };
  return {
    ok: true,
    language: resolved.language,
    parentId,
    input: {
      ...(villagesEnabled() ? { village: input.villageExplicit === false ? declared.village : input.village ?? declared.village } : {}),
      // The title field of the form is a string, empty when there is no title (the service turns an empty title into "no title").
      title: input.title.trim() !== "" ? input.title : declared.title === undefined ? "" : normalizeNewlines(declared.title),
      body: normalizeNewlines(extracted.body),
      lang: resolved.lang, langCode: resolved.langCode, langSource: resolved.langSource,
      aiAssistance: declared.aiAssistance ?? null,
      asksStance: input.asksStance || (declared.asksStance ?? false),
      altOf: input.altOf !== null ? input.altOf : (declared.altOf ?? null),
      stanceTag: input.stanceTag !== null ? input.stanceTag : (declared.stanceTag ?? null),
    },
  };
}

// Posts a topic from the /t/new form. Read frontmatter pasted at the start of the body (applyPastedFrontmatter), then call createTopic.
// The form has no field about how the post was written: record ai_assistance from pasted frontmatter, otherwise null.
// The title may be empty (a topic without a title); "ask for stances" without a title is invalid_title. The limit of posts per hour is counted by the caller (the route), before this.
export async function submitTopicForm(
  db: Db,
  member: { user: Pick<SessionUser, "id">; profile: Pick<Profile, "homeArea" | "readLangs"> },
  form: FormData,
  opts: { now?: Date; responseTo?: number | null } = {},
): Promise<{ ok: true; id: number } | { ok: false; error: EntryError | PastedError; village?: string }> {
  const raw = readEntryForm(form);
  const pasted = (await applyPastedFrontmatter(raw, "topic", { defaultLang: defaultPostLang(member.profile) }));
  if (!pasted.ok) return { ok: false, error: pasted.error };
  const res = await createTopic(db, member.user.id, pasted.input, { now: opts.now, responseTo: opts.responseTo, asIntroduction: formString(form, "intro") === "1", ...(villagesEnabled() ? { villageDisplayed: raw.villageDisplayed ?? "" } : {}) });
  return res.ok ? { ok: true, id: res.id } : { ok: false, error: res.error, ...(res.village === undefined ? {} : { village: res.village }) };
}
