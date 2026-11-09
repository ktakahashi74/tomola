import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, moderationActions, notifications, profiles, reports, villages, villageMembers, chatConsents } from "../app/lib/db/schema";
import { CHAT_CONSENT_VERSION } from "../app/lib/village-chat-consent";
import { mutateChat } from "../app/lib/village-chat.server";
import { createChatReport } from "../app/lib/village-chat-reports.server";
import { createReply, createTopic } from "../app/lib/entries.server";
import { createReport } from "../app/lib/moderation.server";
import { grantModerator } from "../app/lib/roles.server";
import { createModerationHandlers } from "../app/lib/jobs/moderation-jobs.server";
import { runDueJobs } from "../app/lib/jobs/queue.server";

export async function seedAiModeration(db: Db, dir: string) {
  const id = async (handle: string) => (await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, handle)))[0].id;
  const writer = await id("am_ui_writer"), reader = await id("am_ui_reader"), moderator = await id("am_ui_mod");
  await grantModerator(db, moderator, moderator, "en");
  const old = new Date("2019-01-01T00:00:00Z");
  const topic = await createTopic(db, writer, { title: "Automation review example", body: "A report assessment example", lang: "en" }, { now: old });
  if (!topic.ok) throw new Error(topic.error);
  process.env.MODERATION_SPAM_ENABLED = "1";
  process.env.MODERATION_AI_TRIAGE_ENABLED = "1";
  const villageSettings = { VILLAGES: process.env.VILLAGES, VILLAGE_CHAT: process.env.VILLAGE_CHAT };
  try {
    let hiddenId = 0;
    for (let i = 0; i < 3; i++) {
      const reply = await createReply(db, writer, topic.id, { body: "Repeated automation fixture text", lang: "en" }, { now: old });
      if (!reply.ok) throw new Error(reply.error);
      hiddenId = reply.id;
    }
    const report = await createReport(db, reader, { entryId: topic.id, reason: "other", note: "A preliminary review only" });
    if (!report.ok) throw new Error(report.error);
    await runDueJobs(db, createModerationHandlers({ completer: { engine: "fake", model: "fake-moderation", async complete() { return { text: JSON.stringify({ priority: "urgent", assessment: { en: "Potential concern. Human review required.", ja: "問題の疑い。人による確認が必要。" } }), inputTokens: 10, outputTokens: 20 }; } } }), { now: new Date(), limit: 10 });
    await db.update(reports).set({ status: "dismissed", handledBy: moderator, handledAt: old }).where(eq(reports.id, report.id));
    const [action] = await db.select({ id: moderationActions.id }).from(moderationActions).where(eq(moderationActions.targetEntryId, hiddenId));
    const guardWriter = await id("am_guard_writer"), guardReader = await id("am_guard_reader"), guardMod = await id("am_guard_mod");
    await grantModerator(db, guardMod, guardMod, "en");
    process.env.VILLAGES = "1";
    process.env.VILLAGE_CHAT = "1";
    const [village] = await db.insert(villages).values({ slug: "am-guard-chat", name: "Assessment access example", kind: "invite_public" }).returning();
    await db.insert(villageMembers).values([guardWriter, guardReader].map(userId => ({ villageId: village.id, userId, role: "member" })));
    await db.insert(chatConsents).values([guardWriter, guardReader].map(userId => ({ villageId: village.id, userId, version: CHAT_CONSENT_VERSION })));
    const message = await mutateChat(db, guardWriter, village.slug!, "send", { body: "An example for assessment access review" });
    const chatReport = await createChatReport(db, guardReader, { slug: village.slug!, messageId: message.id, reason: "other" });
    await db.update(reports).set({ aiPriority: "urgent", aiAssessment: { en: "PRIVATE_ASSESSMENT_EXAMPLE", ja: "閲覧記録が必要な見立ての例" } }).where(eq(reports.id, chatReport.id));
    const resolvedTopic = await createTopic(db, guardWriter, { title: "Automatic report closure example", body: "A separate report closure example", lang: "en" }, { now: old, villageId: village.id });
    if (!resolvedTopic.ok) throw new Error(resolvedTopic.error);
    const resolvedEntryId = resolvedTopic.id;
    const resolved = await createReport(db, guardReader, { entryId: resolvedEntryId, reason: "other" });
    if (!resolved.ok) throw new Error(resolved.error);
    const { automaticallyHideEntry } = await import("../app/lib/moderation-automation.server");
    await db.transaction(tx => automaticallyHideEntry(tx, resolvedEntryId, "spam: repetition", new Date()));
    fs.writeFileSync(path.join(dir, "ai-moderation.json"), JSON.stringify({ topicId: topic.id, hiddenId, actionId: action.id, chatReportId: chatReport.id, resolvedEntryId }));
    // Keep this fixture away from the fresh-topic lists used by other scenarios.
    await db.update(entries).set({ createdAt: old, lastActivityAt: old }).where(eq(entries.id, topic.id));
    await db.delete(jobs).where(eq(jobs.kind, "moderation_triage"));
    // The automatic hide ran at the fixture's old clock. Date its notification now: a scenario that moves the server clock past the daily cleanup
    // (passkey-fresh) would otherwise have retention erase it as an unread notification older than 180 days, depending on the file order.
    await db.update(notifications).set({ createdAt: new Date() }).where(eq(notifications.actionId, action.id));
  } finally {
    delete process.env.MODERATION_SPAM_ENABLED;
    delete process.env.MODERATION_AI_TRIAGE_ENABLED;
    for (const [key, value] of Object.entries(villageSettings)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
