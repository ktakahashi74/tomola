import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lt, ne } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, postAiMaterials, postAiMaterialVersions, profiles } from "./db/schema";
import { publicTopicPlace } from "./visibility.server";
import { authorLabel } from "./deleted-member";
import { retainedAuthorColumn } from "./deleted-member.server";
import { aiVisibleMarkdown, visibleUnicode } from "./ai-visible-text.server";
import { MarkdownBudgetError } from "./markdown-budget.server";
import { POST_AI_MATERIAL_CHARS, instructionWarnings } from "./post-ai-materials";
import { inScope, type Viewer } from "./roles.server";

export async function preparePostAiMaterial(input: string) {
  if (input.length > POST_AI_MATERIAL_CHARS || Buffer.from(input, "utf8").toString("utf8") !== input) return null;
  const body = visibleUnicode(input).trim();
  let visible;
  try { visible = await aiVisibleMarkdown(body); }
  catch (error) { if (error instanceof MarkdownBudgetError) return null; throw error; }
  if (!visible.text) return null;
  return { body, ...visible, warnings: instructionWarnings(visible.text) };
}

export async function materialTopic(db: Db, topicId: number) {
  const [topic] = await db.select({ id: entries.id, authorId: entries.authorId, lang: entries.langCode, fallbackLang: entries.lang,
    hiddenAt: entries.hiddenAt, author: retainedAuthorColumn(entries.authorId, profiles.handle, "handle") })
    .from(entries).leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(and(eq(entries.id, topicId), eq(entries.kind, "topic"), isNull(entries.deletedAt), publicTopicPlace()));
  return topic ?? null;
}

export async function readPostAiMaterial(db: Db, topicId: number, review?: Viewer | null) {
  const topic = await materialTopic(db, topicId);
  if (!topic) return null;
  const [material] = await db.select().from(postAiMaterials).where(eq(postAiMaterials.topicId, topicId));
  if (!material || !material.body) return null;
  const privileged = review && (review.userId === topic.authorId || inScope(review.scope, topic.fallbackLang));
  if ((topic.hiddenAt || material.hiddenAt) && !privileged) return null;
  const visible = await aiVisibleMarkdown(material.body);
  if (!visible.text) return null;
  return { topicId, instanceId: material.instanceId, materialHidden: !!material.hiddenAt, body: material.body, version: material.version, updatedAt: material.updatedAt, hidden: !!(topic.hiddenAt || material.hiddenAt),
    author: authorLabel(topic.author), authorId: topic.authorId, lang: topic.lang ?? topic.fallbackLang, ...visible };
}

const fail = (error: "not_found" | "forbidden" | "invalid" | "conflict") => ({ ok: false as const, error });
export async function writePostAiMaterial(db: Db, userId: string, topicId: number, input: { body: string; version: number; remove?: boolean }) {
  const prepared = input.remove ? null : await preparePostAiMaterial(input.body);
  if (!input.remove && !prepared) return fail("invalid");
  return db.transaction(async tx => {
    const [entry] = await tx.select().from(entries).where(eq(entries.id, topicId)).for("no key update");
    if (!entry || entry.kind !== "topic" || entry.deletedAt || !await materialTopic(tx, topicId)) return fail("not_found");
    if (entry.authorId !== userId) return fail("forbidden");
    const [old] = await tx.select().from(postAiMaterials).where(eq(postAiMaterials.topicId, topicId));
    if ((old?.version ?? 0) !== input.version) return fail("conflict");
    if (input.remove) {
      if (old?.hiddenAt) {
        // Retain the moderation gate after the author removes all content.
        await tx.delete(postAiMaterialVersions).where(eq(postAiMaterialVersions.topicId, topicId));
        await tx.update(postAiMaterials).set({ body: "", version: old.version + 1, updatedAt: new Date() }).where(eq(postAiMaterials.topicId, topicId));
      } else await tx.delete(postAiMaterials).where(eq(postAiMaterials.topicId, topicId));
      return { ok: true as const, warnings: [] as string[] };
    }
    const version = (old?.version ?? 0) + 1, now = new Date();
    await tx.insert(postAiMaterials).values({ topicId, body: prepared!.body, version, updatedAt: now })
      .onConflictDoUpdate({ target: postAiMaterials.topicId, set: { body: prepared!.body, version, updatedAt: now, ...(!old?.body ? { instanceId: randomUUID() } : {}) } });
    await tx.insert(postAiMaterialVersions).values({ topicId, version, body: prepared!.body, actorId: userId, instructionWarnings: prepared!.warnings, createdAt: now });
    return { ok: true as const, warnings: prepared!.warnings };
  });
}

export async function moderatePostAiMaterial(db: Db, actor: Viewer, topicId: number, hide: boolean, note: string, expectedVersion: number) {
  if (!note.trim() || note.length > 1000) return fail("invalid");
  return db.transaction(async tx => {
    const [entry] = await tx.select().from(entries).where(eq(entries.id, topicId)).for("no key update");
    if (!entry || entry.kind !== "topic" || entry.deletedAt || !await materialTopic(tx, topicId)) return fail("not_found");
    if (actor.userId === entry.authorId || !inScope(actor.scope, entry.lang)) return fail("forbidden");
    const [old] = await tx.select().from(postAiMaterials).where(eq(postAiMaterials.topicId, topicId));
    if (!old?.body) return fail("not_found");
    if (!hide && old.operatorHidden && !actor.scope.operator) return fail("forbidden");
    if (hide && old.hiddenAt) return fail("conflict");
    if (old.version !== expectedVersion) return fail("conflict");
    const version = old.version + 1, now = new Date();
    await tx.update(postAiMaterials).set({ hiddenAt: hide ? now : null, operatorHidden: hide && actor.scope.operator, version, updatedAt: now }).where(eq(postAiMaterials.topicId, topicId));
    await tx.insert(postAiMaterialVersions).values({ topicId, version, body: old.body, actorId: actor.userId, event: hide ? "hide" : "unhide", note: note.trim(), createdAt: now });
    return { ok: true as const };
  });
}

// The topic page needs existence only, without parsing the supplement.
export async function hasPostAiMaterial(db: Db, topicId: number) {
  const [row] = await db.select({ id: postAiMaterials.topicId }).from(postAiMaterials)
    .where(and(eq(postAiMaterials.topicId, topicId), isNull(postAiMaterials.hiddenAt), ne(postAiMaterials.body, "")));
  return !!row;
}

export const POST_AI_HISTORY_PAGE_SIZE = 20;
// Caller first establishes page visibility. Operator-only warnings never enter public data.
export async function postAiMaterialHistory(db: Db, topicId: number, before?: number) {
  const rows = await db.select({ version: postAiMaterialVersions.version, body: postAiMaterialVersions.body,
    event: postAiMaterialVersions.event, createdAt: postAiMaterialVersions.createdAt })
    .from(postAiMaterialVersions).where(and(eq(postAiMaterialVersions.topicId, topicId), before === undefined ? undefined : lt(postAiMaterialVersions.version, before)))
    .orderBy(desc(postAiMaterialVersions.version)).limit(POST_AI_HISTORY_PAGE_SIZE + 1);
  const page = rows.slice(0, POST_AI_HISTORY_PAGE_SIZE), rendered = [];
  for (const row of page) rendered.push({ ...row, ...await aiVisibleMarkdown(row.body) });
  return { rows: rendered, nextBefore: rows.length > page.length ? page.at(-1)!.version : null };
}

export async function exportPostAiMaterials(db: Db, userId: string) {
  const rows = await db.select({ material: postAiMaterials }).from(postAiMaterials).innerJoin(entries, eq(entries.id, postAiMaterials.topicId))
    .where(and(eq(entries.authorId, userId), isNull(entries.deletedAt), ne(postAiMaterials.body, ""))).orderBy(asc(postAiMaterials.topicId));
  return Promise.all(rows.map(async ({ material }) => ({ topic_id: material.topicId, body: material.body, version: material.version,
    hidden: !!material.hiddenAt, updated_at: material.updatedAt.toISOString(), versions: (await db.select().from(postAiMaterialVersions).where(eq(postAiMaterialVersions.topicId, material.topicId)).orderBy(asc(postAiMaterialVersions.version)))
      .map(({ version, body, event, createdAt }) => ({ version, body, event, created_at: createdAt.toISOString() })) })));
}
