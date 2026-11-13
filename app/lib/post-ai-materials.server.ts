import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, postAiMaterials, postAiMaterialVersions, profiles } from "./db/schema";
import { publicTopicPlace } from "./visibility.server";
import { authorLabel } from "./deleted-member";
import { retainedAuthorColumn } from "./deleted-member.server";
import { aiVisibleMarkdown, visibleUnicode } from "./ai-visible-text.server";
import { POST_AI_MATERIAL_CHARS, instructionWarnings } from "./post-ai-materials";
import { inScope, type Viewer } from "./roles.server";

export function preparePostAiMaterial(input: string) {
  if (input.length > POST_AI_MATERIAL_CHARS || Buffer.from(input, "utf8").toString("utf8") !== input) return null;
  const body = visibleUnicode(input).trim();
  const visible = aiVisibleMarkdown(body);
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
  if (!material) return null;
  const privileged = review && (review.userId === topic.authorId || inScope(review.scope, topic.fallbackLang));
  if ((topic.hiddenAt || material.hiddenAt) && !privileged) return null;
  const visible = aiVisibleMarkdown(material.body);
  return { topicId, instanceId: material.instanceId, materialHidden: !!material.hiddenAt, body: material.body, version: material.version, updatedAt: material.updatedAt, hidden: !!(topic.hiddenAt || material.hiddenAt),
    author: authorLabel(topic.author), authorId: topic.authorId, lang: topic.lang ?? topic.fallbackLang, ...visible };
}

const fail = (error: "not_found" | "forbidden" | "invalid" | "conflict") => ({ ok: false as const, error });
export async function writePostAiMaterial(db: Db, userId: string, topicId: number, input: { body: string; version: number; remove?: boolean }) {
  const prepared = input.remove ? null : preparePostAiMaterial(input.body);
  if (!input.remove && !prepared) return fail("invalid");
  return db.transaction(async tx => {
    const [entry] = await tx.select().from(entries).where(eq(entries.id, topicId)).for("no key update");
    if (!entry || entry.kind !== "topic" || entry.deletedAt || !await materialTopic(tx, topicId)) return fail("not_found");
    if (entry.authorId !== userId) return fail("forbidden");
    const [old] = await tx.select().from(postAiMaterials).where(eq(postAiMaterials.topicId, topicId));
    if ((old?.version ?? 0) !== input.version) return fail("conflict");
    if (input.remove) {
      await tx.delete(postAiMaterials).where(eq(postAiMaterials.topicId, topicId));
      return { ok: true as const, warnings: [] as string[] };
    }
    const version = (old?.version ?? 0) + 1, now = new Date();
    await tx.insert(postAiMaterials).values({ topicId, body: prepared!.body, version, updatedAt: now })
      .onConflictDoUpdate({ target: postAiMaterials.topicId, set: { body: prepared!.body, version, updatedAt: now } });
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
    if (!old) return fail("not_found");
    if (!hide && old.operatorHidden && !actor.scope.operator) return fail("forbidden");
    if (old.version !== expectedVersion) return fail("conflict");
    const version = old.version + 1, now = new Date();
    await tx.update(postAiMaterials).set({ hiddenAt: hide ? now : null, operatorHidden: hide && actor.scope.operator, version, updatedAt: now }).where(eq(postAiMaterials.topicId, topicId));
    await tx.insert(postAiMaterialVersions).values({ topicId, version, body: old.body, actorId: actor.userId, event: hide ? "hide" : "unhide", note: note.trim(), createdAt: now });
    return { ok: true as const };
  });
}

// Caller first establishes page visibility. Operator-only warnings never enter public data.
export async function postAiMaterialHistory(db: Db, topicId: number) {
  const rows = await db.select({ version: postAiMaterialVersions.version, body: postAiMaterialVersions.body,
    event: postAiMaterialVersions.event, createdAt: postAiMaterialVersions.createdAt })
    .from(postAiMaterialVersions).where(eq(postAiMaterialVersions.topicId, topicId)).orderBy(asc(postAiMaterialVersions.version));
  return rows.map(row => ({ ...row, ...aiVisibleMarkdown(row.body) }));
}

export async function exportPostAiMaterials(db: Db, userId: string) {
  const rows = await db.select({ material: postAiMaterials }).from(postAiMaterials).innerJoin(entries, eq(entries.id, postAiMaterials.topicId))
    .where(and(eq(entries.authorId, userId), isNull(entries.deletedAt))).orderBy(asc(postAiMaterials.topicId));
  return Promise.all(rows.map(async ({ material }) => ({ topic_id: material.topicId, body: material.body, version: material.version,
    hidden: !!material.hiddenAt, updated_at: material.updatedAt.toISOString(), versions: (await postAiMaterialHistory(db, material.topicId))
      .map(({ version, body, event, createdAt }) => ({ version, body, event, created_at: createdAt.toISOString() })) })));
}
