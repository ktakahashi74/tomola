import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, notifications, profiles, roles, translationReports, translations, user } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { setFollow } from "../app/lib/follows.server";
import { hideEntry } from "../app/lib/moderation.server";
import { createDraft } from "../app/lib/drafts.server";
import { createGlossaryEntry } from "../app/lib/glossary.server";
export type EarlyFixture = { reports: { topicId: number; replyId: number }; parent: { topicId: number; firstId: number; lastId: number }; navigation: { topicId: number; replyId: number; notificationId: number }; audit: { topicId: number; actionId: number; reportId: number; draftId: number; glossaryId: number } };

export async function seedEarlyActions(db: Db, dir: string) {
  const [author] = await db.select({ id: user.id }).from(user).where(eq(user.email, "early_source@example.com"));
  const ids: number[] = [];
  const topic = async (title: string, lang: "en" | "ja") => {
    const created = await createTopic(db, author.id, { lang, title, body: "## First section\n\nAn owned early-action fixture.\n\n## Second section\n\nMore text.\n\n## Third section\n\nThe end." });
    if (!created.ok) throw new Error("Early-action topic seed failed");
    ids.push(created.id);
    return created.id;
  };
  const reply = async (topicId: number, body: string, parentId?: number) => {
    const created = await createReply(db, author.id, topicId, { lang: "ja", body, parentId });
    if (!created.ok) throw new Error("Early-action reply seed failed");
    ids.push(created.id);
    return created.id;
  };
  const reportsId = await topic("Early report controls", "ja");
  const reportReplyId = await reply(reportsId, "Early report reply");
  const navigationId = await topic("Early navigation controls", "ja");
  const navigationReplyId = await reply(navigationId, "Early navigation reply @early_navigation");
  const [navigator] = await db.select({ id: user.id }).from(user).where(eq(user.email, "early_navigation@example.com"));
  await setFollow(db, navigator.id, navigationId, true);
  const [notice] = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.userId, navigator.id));
  for (const id of [reportsId, reportReplyId, navigationId]) {
    const [source] = await db.select().from(entries).where(eq(entries.id, id));
    await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: source.body });
  }
  const parentTopicId = await topic("Early parent navigation", "en");
  const firstId = await reply(parentTopicId, "Early parent destination");
  for (let i = 0; i < 99; i++) await reply(parentTopicId, `Early pagination spacer ${i}`);
  const lastId = await reply(parentTopicId, "Early parent link", firstId);
  const account = async (name: string) => (await db.select({ id: user.id }).from(user).where(eq(user.email, `early_${name}@example.com`)))[0];
  const audit = await account("audit"), actor = await account("actor"), reviewer = await account("reviewer");
  for (const member of [actor, reviewer]) for (const lang of ["en", "ja"]) await db.insert(roles).values({ userId: member.id, role: "moderator", lang });
  const question = await createTopic(db, audit.id, { title: "Early disclosure audit", body: "An owned question for disclosure checks.", lang: "en", asksStance: true });
  if (!question.ok) throw new Error("Early audit question seed failed");
  const reason = await createReply(db, actor.id, question.id, { lang: "en", body: "An owned reason for the disclosure audit.", stanceTag: "agree" });
  if (!reason.ok) throw new Error("Early audit reason seed failed");
  ids.push(question.id, reason.id);
  const appealed = await createTopic(db, audit.id, { title: "Early appeal disclosure", body: "An owned appealed post.", lang: "en" });
  if (!appealed.ok) throw new Error("Early appeal topic seed failed");
  ids.push(appealed.id);
  const hidden = await hideEntry(db, { id: actor.id, scope: { operator: false, langs: ["en", "ja"] } }, { entryId: appealed.id, reason: "other", note: "Early disclosure audit" });
  if (!hidden.ok) throw new Error("Early appeal action seed failed");
  const [report] = await db.insert(translationReports).values({ entryId: question.id, reporterId: audit.id, lang: "en", field: "body", route: "moderator" }).returning({ id: translationReports.id });
  const draft = await createDraft(db, audit.id, { kind: "topic", title: "Early draft disclosure", body: "An owned draft.", lang: "en" }, { via: "api", rawFrontmatter: "title: Early draft disclosure" });
  if (!draft.ok) throw new Error("Early draft seed failed");
  const glossary = await createGlossaryEntry(db, { userId: actor.id, scope: { operator: false, langs: ["en", "ja"] } }, { term: "early_audit_term", lang: "ja", targetLang: "en", candidates: ["early audit term"] });
  if (!glossary.ok) throw new Error("Early glossary seed failed");
  await db.delete(profiles).where(eq(profiles.userId, (await account("onboarding")).id));
  await db.delete(jobs).where(inArray(sql<number>`(${jobs.payload}->>'entryId')::bigint`, ids));
  if (!notice) throw new Error("Early-action notification seed failed");
  const fixture: EarlyFixture = { reports: { topicId: reportsId, replyId: reportReplyId }, parent: { topicId: parentTopicId, firstId, lastId }, navigation: { topicId: navigationId, replyId: navigationReplyId, notificationId: notice.id }, audit: { topicId: question.id, actionId: hidden.actionId, reportId: report.id, draftId: draft.id, glossaryId: glossary.id } };
  fs.writeFileSync(path.join(dir, "early-actions.json"), JSON.stringify(fixture));
}
