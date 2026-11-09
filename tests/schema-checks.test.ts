import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { apiTokens, divergences, drafts, entries, follows, glossaryEntries, glossaryRevisions, invitations, jobs, llmUsage, moderationActions, notifications, notifiedMentions, profiles, reports, translationReports, translations } from "~/lib/db/schema";
import { FOLLOW_STATES } from "~/lib/follows";
import { EMAIL_PREFS, NOTIFICATION_KINDS } from "~/lib/notifications";
import { GLOSSARY_VIAS } from "~/lib/glossary";
import { createTopic } from "~/lib/entries.server";
import { STANCE_TAGS } from "~/lib/stances";
import { addMember, createTestDb } from "./helpers/db";

// CHECK constraints on enum-valued text columns, migration 0012, and the invitations.email index.
// Reject invalid inserts with the constraint name; Drizzle stores the driver error in cause.
async function rejects(run: () => Promise<unknown>, constraint: string) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${constraint} to reject`).toBeDefined();
  const cause = (caught as { cause?: { message?: string; constraint?: string } }).cause;
  expect(`${cause?.constraint ?? ""} ${cause?.message ?? ""} ${(caught as Error).message}`).toContain(constraint);
}

async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文。" });
  if (!topic.ok) throw new Error("topic failed");
  return { db, topicId: topic.id };
}

const entryValues = (over: Record<string, unknown> = {}) => ({ kind: "topic", authorId: "u1", lang: "ja", title: "t", body: "b", ...over }) as typeof entries.$inferInsert;
const translationValues = (entryId: number, over: Record<string, unknown> = {}) =>
  ({ entryId, field: "body", lang: "en", kind: "primary", text: "x", ...over }) as typeof translations.$inferInsert;

describe("enum CHECK constraints", () => {
  it("rejects a value outside the enumeration in every constrained column, and accepts the valid ones", async () => {
    const { db, topicId } = await setup();
    await rejects(() => db.insert(entries).values(entryValues({ kind: "comment" })), "entries_kind_check");
    await rejects(() => db.insert(entries).values(entryValues({ lang: "xx" })), "entries_lang_check");
    await rejects(() => db.insert(entries).values(entryValues({ lang: "other" })), "entries_lang_check");
    await rejects(() => db.insert(entries).values(entryValues({ aiAssistance: "full" })), "entries_ai_assistance_check");
    await rejects(() => db.insert(entries).values(entryValues({ via: "sms" })), "entries_via_check");
    await db.insert(entries).values(entryValues({ lang: "zh-Hant", aiAssistance: "coauthor", via: "api" }));

    await rejects(() => db.update(profiles).set({ homeArea: "xx" }), "profiles_home_area_check");
    await db.update(profiles).set({ homeArea: "other" });

    await rejects(() => db.insert(translations).values(translationValues(topicId, { field: "summary" })), "translations_field_check");
    await rejects(() => db.insert(translations).values(translationValues(topicId, { lang: "ja-JP" })), "translations_lang_check");
    await rejects(() => db.insert(translations).values(translationValues(topicId, { kind: "draft" })), "translations_kind_check");
    // Author translations, kind author, were removed in migration 0042.
    await rejects(() => db.insert(translations).values(translationValues(topicId, { kind: "author" })), "translations_kind_check");
    await db.insert(translations).values(translationValues(topicId, { kind: "human" }));

    await rejects(() => db.insert(jobs).values({ kind: "k", status: "paused" }), "jobs_status_check");
    await rejects(() => db.insert(divergences).values({ entryId: topicId, lang: "en", segmentIdx: 0, severity: "critical", note: "n" }), "divergences_severity_check");
    await rejects(() => db.insert(translationReports).values({ entryId: topicId, lang: "en", field: "body", reporterId: "u1", status: "closed" }), "translation_reports_status_check");
    await rejects(() => db.insert(llmUsage).values({ engine: "fake", model: "m", purpose: "summary" }), "llm_usage_purpose_check");
    await db.insert(llmUsage).values({ engine: "fake", model: "m", purpose: "chat" });
    await rejects(() => db.insert(drafts).values({ authorId: "u1", kind: "note", lang: "ja" }), "drafts_kind_check");
    await rejects(() => db.insert(drafts).values({ authorId: "u1", kind: "topic", lang: "ja", via: "sms" }), "drafts_via_check");
    await db.insert(drafts).values({ authorId: "u1", kind: "reply", lang: "ja", via: "api" });

    // API tokens (0021).
    await rejects(() => db.insert(apiTokens).values({ userId: "u1", name: "n", kind: "write", tokenHash: "h1" }), "api_tokens_kind_check");
    await db.insert(apiTokens).values({ userId: "u1", name: "n", kind: "draft", tokenHash: "h2" });
    await rejects(() => db.insert(apiTokens).values({ userId: "u1", name: "n", kind: "read", tokenHash: "h2" }), "api_tokens_token_hash_unique");

    // Reports and moderation actions (0029).
    await addMember(db, "u2", "taro");
    await rejects(() => db.insert(reports).values({ entryId: topicId, reporterId: "u2", reason: "rude" }), "reports_reason_check");
    await rejects(() => db.insert(reports).values({ entryId: topicId, reporterId: "u2", reason: "spam", status: "closed" }), "reports_status_check");
    await db.insert(reports).values({ entryId: topicId, reporterId: "u2", reason: "spam" });
    await rejects(() => db.insert(reports).values({ entryId: topicId, reporterId: "u2", reason: "other" }), "reports_entry_reporter_unique");
    await rejects(() => db.insert(moderationActions).values({ action: "ban", reason: "spam", actorId: "u2", targetEntryId: topicId }), "moderation_actions_action_check");
    await rejects(() => db.insert(moderationActions).values({ action: "hide", reason: "rude", actorId: "u2", targetEntryId: topicId }), "moderation_actions_reason_check");
    // Suspensions always have an expiry.
    await rejects(() => db.insert(moderationActions).values({ action: "suspend", reason: "spam", actorId: "u2", targetUserId: "u1" }), "moderation_actions_suspend_until_check");
    await db.insert(moderationActions).values({ action: "suspend", reason: "spam", actorId: "u2", targetUserId: "u1", until: new Date() });
    await db.insert(moderationActions).values({ action: "restore", reason: "other", actorId: "u2", targetEntryId: topicId });
    // Post actions always require a post; member actions always require a member.
    for (const action of ["hide", "unhide", "delete", "restore", "dismiss_report"]) {
      await rejects(() => db.insert(moderationActions).values({ action, reason: "spam", actorId: "u2" }), "moderation_actions_target_check");
      await rejects(() => db.insert(moderationActions).values({ action, reason: "spam", actorId: "u2", targetUserId: "u1" }), "moderation_actions_target_check");
      await db.insert(moderationActions).values({ action, reason: "spam", actorId: "u2", targetEntryId: topicId });
    }
    for (const action of ["suspend", "unsuspend"]) {
      await rejects(() => db.insert(moderationActions).values({ action, reason: "spam", actorId: "u2", until: new Date() }), "moderation_actions_target_check");
      await rejects(() => db.insert(moderationActions).values({ action, reason: "spam", actorId: "u2", targetEntryId: topicId, until: new Date() }), "moderation_actions_target_check");
    }
    await db.insert(moderationActions).values({ action: "unsuspend", reason: "spam", actorId: "u2", targetUserId: "u1" });
  });
});

describe("question attributes (0041: asks_stance, alt_of, stance_tag, stance_locked_at)", () => {
  it("lets only a topic be a question, only a question point at another question, only a reply carry a tag from the enumeration, and only a question be locked", async () => {
    const { db, topicId } = await setup();
    const reply = (over: Record<string, unknown> = {}) => entryValues({ kind: "reply", threadId: topicId, title: null, ...over });
    // Only topics can be questions.
    await rejects(() => db.insert(entries).values(reply({ asksStance: true })), "entries_asks_stance_kind_check");
    const [question] = await db.insert(entries).values(entryValues({ asksStance: true })).returning({ id: entries.id });
    // Only questions can be alternatives, and they cannot reference themselves.
    await rejects(() => db.insert(entries).values(entryValues({ altOf: question.id })), "entries_alt_of_check");
    await rejects(() => db.update(entries).set({ altOf: question.id }).where(sql`${entries.id} = ${question.id}`), "entries_alt_of_check");
    const [alt] = await db.insert(entries).values(entryValues({ asksStance: true, altOf: question.id })).returning({ id: entries.id });
    expect((await db.select({ altOf: entries.altOf }).from(entries).where(sql`${entries.id} = ${alt.id}`))[0].altOf).toBe(question.id);
    // Only replies can have stance tags, limited to four values; constants and constraints agree.
    await rejects(() => db.insert(entries).values(entryValues({ stanceTag: "agree" })), "entries_stance_tag_check");
    await rejects(() => db.insert(entries).values(reply({ stanceTag: "maybe" })), "entries_stance_tag_check");
    for (const tag of STANCE_TAGS) await db.insert(entries).values(reply({ stanceTag: tag }));
    await db.insert(entries).values(reply());
    // Only questions can be locked.
    await rejects(() => db.insert(entries).values(entryValues({ stanceLockedAt: new Date() })), "entries_stance_locked_check");
    await db.insert(entries).values(entryValues({ asksStance: true, stanceLockedAt: new Date() }));
    // Physically deleting the original question in the test preserves the alternative row and clears only alt_of.
    await db.execute(sql`delete from entries where id = ${question.id}`);
    expect((await db.select({ altOf: entries.altOf, asks: entries.asksStance }).from(entries).where(sql`${entries.id} = ${alt.id}`))[0]).toEqual({ altOf: null, asks: true });
  });

  it("applies the same rules to drafts, and a draft keeps pointing nowhere when the question is deleted", async () => {
    const { db } = await setup();
    const [question] = await db.insert(entries).values(entryValues({ asksStance: true })).returning({ id: entries.id });
    const draft = (over: Record<string, unknown> = {}) => ({ authorId: "u1", kind: "topic", lang: "ja", ...over }) as typeof drafts.$inferInsert;
    await rejects(() => db.insert(drafts).values(draft({ kind: "reply", asksStance: true })), "drafts_asks_stance_kind_check");
    await rejects(() => db.insert(drafts).values(draft({ altOf: question.id })), "drafts_alt_of_check");
    await rejects(() => db.insert(drafts).values(draft({ kind: "reply", asksStance: false, altOf: question.id })), "drafts_alt_of_check");
    await rejects(() => db.insert(drafts).values(draft({ stanceTag: "agree" })), "drafts_stance_tag_check");
    await rejects(() => db.insert(drafts).values(draft({ kind: "reply", stanceTag: "maybe" })), "drafts_stance_tag_check");
    for (const tag of STANCE_TAGS) await db.insert(drafts).values(draft({ kind: "reply", stanceTag: tag }));
    const [d] = await db.insert(drafts).values(draft({ asksStance: true, altOf: question.id })).returning({ id: drafts.id });
    await db.execute(sql`delete from entries where id = ${question.id}`);
    expect((await db.select({ altOf: drafts.altOf }).from(drafts).where(sql`${drafts.id} = ${d.id}`))[0].altOf).toBeNull();
  });
});

describe("drafts.token_id", () => {
  it("is only set on drafts that came through the API (0040), and an API draft stays when its token is deleted", async () => {
    const { db } = await setup();
    const [token] = await db.insert(apiTokens).values({ userId: "u1", name: "n", kind: "draft", tokenHash: "h1" }).returning({ id: apiTokens.id });
    await rejects(() => db.insert(drafts).values({ authorId: "u1", kind: "topic", lang: "ja", via: "web", tokenId: token.id }), "drafts_token_via_check");
    await db.insert(drafts).values({ authorId: "u1", kind: "topic", lang: "ja", via: "web" });
    const [api] = await db.insert(drafts).values({ authorId: "u1", kind: "topic", lang: "ja", via: "api", tokenId: token.id }).returning({ id: drafts.id });
    // The foreign key uses SET NULL: deleting a token row preserves its API drafts; via=api satisfies the constraint.
    await db.execute(sql`delete from api_tokens where id = ${token.id}`);
    expect((await db.select({ via: drafts.via, tokenId: drafts.tokenId }).from(drafts).where(sql`${drafts.id} = ${api.id}`))[0]).toEqual({ via: "api", tokenId: null });
  });
});

describe("invitations.email index", () => {
  it("exists, so the lookup by email can use it", async () => {
    const db: Db = await createTestDb();
    const res = (await db.execute(sql`select indexdef from pg_indexes where tablename = 'invitations' and indexname = 'invitations_email_idx'`)) as unknown as {
      rows: Array<{ indexdef: string }>;
    };
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].indexdef).toContain("(email)");
    await db.insert(invitations).values({ id: "i1", email: "a@example.com", tokenHash: "t", expiresAt: new Date() });
  });
});

describe("glossary_revisions", () => {
  it("takes only a via from the enumeration, needs a before or an after, and points at an entry that exists", async () => {
    const { db } = await setup();
    const [entry] = await db.insert(glossaryEntries).values({ term: "a", lang: "en", targetLang: "ja", candidates: ["x"] }).returning({ id: glossaryEntries.id });
    const content = { term: "a", candidates: ["x"], note: "", keepOriginal: false, needsReview: false };
    await rejects(() => db.insert(glossaryRevisions).values({ entryId: entry.id, before: null, after: content, via: "sms" }), "glossary_revisions_via_check");
    await rejects(() => db.insert(glossaryRevisions).values({ entryId: entry.id, before: null, after: null }), "glossary_revisions_change_check");
    await rejects(() => db.insert(glossaryRevisions).values({ entryId: 9999, before: null, after: content }), "glossary_revisions_entry_id_glossary_entries_id_fk");
    for (const via of GLOSSARY_VIAS) await db.insert(glossaryRevisions).values({ entryId: entry.id, before: null, after: content, via });
    // The editor and the proposal post are optional (a deleted member, a physically deleted post); the default via is the admin page
    const [row] = await db.insert(glossaryRevisions).values({ entryId: entry.id, before: content, after: null }).returning();
    expect(row).toMatchObject({ via: "admin", editorId: null, proposalEntryId: null });
  });
});

describe("follows and the notification columns", () => {
  it("follows takes the states of FOLLOW_STATES, one row per member and topic, and goes with the member and the topic", async () => {
    const { db, topicId } = await setup();
    await addMember(db, "u2", "taro");
    await rejects(() => db.insert(follows).values({ userId: "u2", threadId: topicId, state: "maybe" }), "follows_state_check");
    for (const state of FOLLOW_STATES) {
      await db.insert(follows).values({ userId: "u2", threadId: topicId, state });
      await rejects(() => db.insert(follows).values({ userId: "u2", threadId: topicId, state }), "follows_user_id_thread_id_pk");
      await db.delete(follows).where(sql`${follows.userId} = 'u2'`);
    }
    await rejects(() => db.insert(follows).values({ userId: "u2", threadId: 999999, state: "following" }), "follows_thread_id_entries_id_fk");
    await db.insert(follows).values({ userId: "u2", threadId: topicId, state: "following" });
    await db.execute(sql`delete from profiles where user_id = 'u2'`);
    await db.execute(sql`delete from "user" where id = 'u2'`);
    // u2's rows went with u2; the author's own automatic follow is still there
    expect((await db.select().from(follows)).map((f) => f.userId)).toEqual(["u1"]);
    // Deleting a topic for good takes its follows with it (the real deletion is a soft delete; this is for tests and manual cleanup)
    const [bare] = await db.insert(entries).values(entryValues()).returning({ id: entries.id });
    await db.insert(follows).values({ userId: "u1", threadId: bare.id, state: "following" });
    await db.execute(sql`delete from entries where id = ${bare.id}`);
    expect((await db.select().from(follows)).map((f) => f.threadId)).toEqual([topicId]);
  });

  it("notifications.kind takes the kinds of NOTIFICATION_KINDS, and email_pref the preferences of EMAIL_PREFS", async () => {
    const { db, topicId } = await setup();
    await rejects(() => db.insert(notifications).values({ userId: "u1", kind: "mention_all", entryId: topicId }), "notifications_kind_check");
    const [resultReport] = await db.insert(translationReports).values({ entryId: topicId, reporterId: "u1", lang: "en", field: "body", status: "resolved", outcome: "unchanged", resolvedAt: new Date() }).returning();
    for (const kind of NOTIFICATION_KINDS) await db.insert(notifications).values({ userId: "u1", kind, entryId: topicId, threadId: topicId, translationReportId: kind === "translation_report_result" ? resultReport.id : null });
    await rejects(() => db.update(profiles).set({ emailPref: "weekly" }), "profiles_email_pref_check");
    for (const pref of EMAIL_PREFS) await db.update(profiles).set({ emailPref: pref });
  });
});

describe("mentions", () => {
  it("has a notification kind for every value of NOTIFICATION_KINDS, mention included, and no other", async () => {
    const { db, topicId } = await setup();
    await addMember(db, "u2", "taro");
    expect(NOTIFICATION_KINDS).toContain("mention");
    await rejects(() => db.insert(notifications).values({ userId: "u2", kind: "shout", entryId: topicId }), "notifications_kind_check");
    const [resultReport] = await db.insert(translationReports).values({ entryId: topicId, reporterId: "u2", lang: "en", field: "body", status: "resolved", outcome: "unchanged", resolvedAt: new Date() }).returning();
    for (const kind of NOTIFICATION_KINDS) await db.insert(notifications).values({ userId: "u2", kind, entryId: topicId, threadId: topicId, translationReportId: kind === "translation_report_result" ? resultReport.id : null });
  });

  it("keeps one row per (post, member) in notified_mentions, and removes the rows with the member or the post", async () => {
    const { db, topicId } = await setup();
    await addMember(db, "u2", "taro");
    await db.insert(notifiedMentions).values({ entryId: topicId, userId: "u2" });
    await rejects(() => db.insert(notifiedMentions).values({ entryId: topicId, userId: "u2" }), "notified_mentions_entry_id_user_id_pk");
    await rejects(() => db.insert(notifiedMentions).values({ entryId: 9999, userId: "u2" }), "notified_mentions_entry_id_entries_id_fk");
    await rejects(() => db.insert(notifiedMentions).values({ entryId: topicId, userId: "nobody" }), "notified_mentions_user_id_user_id_fk");
    const [other] = await db.insert(entries).values(entryValues()).returning({ id: entries.id });
    await db.insert(notifiedMentions).values({ entryId: other.id, userId: "u2" });
    await db.execute(sql`delete from entries where id = ${other.id}`);
    expect(await db.select().from(notifiedMentions)).toHaveLength(1);
    await db.execute(sql`delete from "user" where id = 'u2'`);
    expect(await db.select().from(notifiedMentions)).toHaveLength(0);
  });
});
