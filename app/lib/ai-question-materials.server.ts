import { readPostAiMaterial } from "./post-ai-materials.server";
import { aiVisibleMarkdown, visibleUnicode } from "./ai-visible-text.server";
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, profiles } from "./db/schema";
import { rootTopic, rootTopicOn, visibleWithTopic } from "./visibility.server";
import { retainedAuthorColumn } from "./deleted-member.server";
import { authorLabel } from "./deleted-member";
import { loadMdTranslations } from "./md/translations.server";
import { loadReplyLocations } from "./reply-locations.server";
import { AI_QUESTION_LIMITS, clipQuestionText, type AiQuestionScope } from "./ai-questions";
import type { Lang, SourceLang } from "./languages";

export type AiQuestionSource = {
  id: string;
  kind: "post" | "reply" | "material";
  field: "title" | "body";
  author: string;
  lang: string;
  original: string;
  href: string;
  sourceHash: string | null;
  quoteLanguage?: Lang;
  translation?: { text: string; lang: Lang; stale: boolean };
};
export type AiQuestionMaterials = { sources: AiQuestionSource[]; scope: AiQuestionScope };

export async function projectQuestionSource<T extends Pick<AiQuestionSource, "kind" | "field" | "author" | "original" | "translation">>(raw: T): Promise<T> {
  const project = async (text: string) => raw.field === "title" ? visibleUnicode(text) : (await aiVisibleMarkdown(text, raw.kind !== "material")).text;
  return { ...raw, author: visibleUnicode(raw.author), original: await project(raw.original), ...(raw.translation ? { translation: { ...raw.translation, text: await project(raw.translation.text) } } : {}) };
}

const columns = {
  id: entries.id, kind: entries.kind, lang: entries.lang, langCode: entries.langCode,
  title: entries.title, body: entries.body, sourceHash: entries.sourceHash,
  handle: retainedAuthorColumn(entries.authorId, profiles.handle, "handle"),
};

// This gate also excludes hidden content from authors and moderators. Their
// ability to review a hidden post does not make it material for an AI question.
export async function readableQuestionPost(db: Db, id: number) {
  const [row] = await db.select({ id: entries.id }).from(entries).innerJoin(rootTopic, rootTopicOn())
    .where(and(eq(entries.id, id), eq(entries.kind, "topic"), visibleWithTopic()));
  return row ?? null;
}

// Limit text independently of its retrieval method, so a later search can use
// the same bounded materials, prompt and citation verifier.
export async function boundQuestionMaterials(inputs: readonly AiQuestionSource[], moreReplies = false): Promise<AiQuestionMaterials> {
  let remaining: number = AI_QUESTION_LIMITS.materialChars;
  let truncated = moreReplies;
  const sources: AiQuestionSource[] = [];
  for (const raw of inputs) {
    const input = await projectQuestionSource(raw);
    const translation = input.translation?.text.trim() ? input.translation : undefined;
    const translated = translation?.text;
    const originalCap = translated
      ? Math.min(AI_QUESTION_LIMITS.sourceChars, remaining - Math.min(translated.length, Math.ceil(remaining / 2)))
      : Math.min(AI_QUESTION_LIMITS.sourceChars, remaining);
    const original = clipQuestionText(input.original, originalCap);
    const text = translated ? clipQuestionText(translated, Math.min(AI_QUESTION_LIMITS.sourceChars, remaining - original.length)) : undefined;
    if (!original.trim() || (translated && !text?.trim())) { truncated = true; continue; }
    truncated ||= original.length < input.original.length || (translated !== undefined && text!.length < translated.length);
    remaining -= original.length + (text?.length ?? 0);
    const { translation: _translation, ...source } = input;
    sources.push({ ...source, original, ...(translation ? { translation: { ...translation, text: text! } } : {}) });
  }
  return { sources, scope: { sources: sources.length, replies: new Set(sources.filter(s => s.kind === "reply").map(s => s.id.replace(/-(title|body)$/, ""))).size, truncated } };
}

export async function postQuestionMaterials(db: Db, topicId: number, language: Lang): Promise<AiQuestionMaterials | null> {
  // Read the post and its visible replies from one statement snapshot. The
  // explicit id/thread predicate also retains the existing index paths.
  const candidates = await db.select(columns).from(entries).innerJoin(rootTopic, rootTopicOn())
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(and(eq(rootTopic.id, topicId), or(eq(entries.id, topicId), eq(entries.threadId, topicId)), visibleWithTopic()))
    .orderBy(sql`case when ${entries.kind} = 'topic' then 0 else 1 end`, asc(entries.createdAt), asc(entries.id))
    .limit(AI_QUESTION_LIMITS.replies + 2);
  const topic = candidates.find(row => row.id === topicId && row.kind === "topic");
  if (!topic) return null;
  const replies = candidates.filter(row => row.kind === "reply");
  const selected = replies.slice(0, AI_QUESTION_LIMITS.replies);
  const rows = [topic, ...selected];
  const [translations, locations] = await Promise.all([
    loadMdTranslations(db, rows.map(row => ({ id: row.id, lang: row.lang as SourceLang, sourceHash: row.sourceHash })), language),
    loadReplyLocations(db, [topicId], selected.map(row => row.id)),
  ]);
  const sources: AiQuestionSource[] = [];
  for (const row of rows) {
    const location = row.kind === "topic" ? { state: "visible" as const, href: `/t/${topicId}` } : locations.get(row.id);
    if (location?.state !== "visible") continue;
    const tr = translations.shown.get(row.id)?.[0];
    for (const field of ["title", "body"] as const) {
      const original = row[field];
      if (!original?.trim()) continue;
      const translated = field === "title" ? tr?.title : tr?.text;
      sources.push({
        id: `e-${row.id}-${field}`, kind: row.kind === "topic" ? "post" : "reply", field,
        author: authorLabel(row.handle), lang: row.langCode ?? row.lang, sourceHash: row.sourceHash,
        original, href: location.href,
        ...(tr && translated?.trim() ? { translation: { text: translated, lang: language, stale: tr.stale } } : {}),
      });
    }
  }
  const material = await readPostAiMaterial(db, topicId);
  if (material) sources.splice(topic.title ? 2 : 1, 0, { id: `m-${topicId}-${material.version}`, kind: "material", field: "body",
    author: material.author, lang: material.lang, original: material.body, href: `/t/${topicId}/ai-materials`, sourceHash: `${material.instanceId}:${material.version}`, ...(material.lang !== language ? { quoteLanguage: language } : {}) });
  return boundQuestionMaterials(sources, replies.length > selected.length);
}
