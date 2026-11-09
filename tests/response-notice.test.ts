import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTopic, editEntry } from "~/lib/entries.server";
import { drafts, entries, notifications, profiles, translations, user, villages } from "~/lib/db/schema";
import { createDraft, getDraft, publishDraft } from "~/lib/drafts.server";
import { draftRecoveryToken } from "~/lib/draft-recovery.server";
import { setFollow } from "~/lib/follows.server";
import { countUnreadNotifications, listNotifications } from "~/lib/notifications.server";
import { notificationDestination } from "~/lib/notification-opening.server";
import { groupThreadNotifications } from "~/lib/group-thread-notifications";
import { DELETED_MEMBER_ID, DELETED_MEMBER_EMAIL } from "~/lib/deleted-member";
import { runRetentionCleanup } from "~/lib/retention.server";
import { RETENTION } from "~/lib/retention";
import { responsePostLine, responsePostPrefill } from "~/lib/response-post.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const handle of ["znotice_source", "znotice_writer", "znotice_follower"]) await h.signIn(handle, { homeArea: "en" });
});
afterAll(() => h.restore());
async function topic(author = "znotice_source", responseTo?: number, body = "Response material") {
  const result = await createTopic(h.db, h.ids[author], { lang: "en", title: "Source topic", body }, { responseTo });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}
const notices = (id: number) => h.db.select().from(notifications).where(eq(notifications.entryId, id));

it("notifies only the source author, subsumes mentions even after edits, and opens the response as a topic", async () => {
  const source = await topic();
  await setFollow(h.db, h.ids.znotice_follower, source, true);
  const before = await countUnreadNotifications(h.db, h.ids.znotice_source);
  const response = await topic("znotice_writer", source, "@znotice_source A new response");
  const rows = await notices(response);
  expect(rows).toEqual([expect.objectContaining({ userId: h.ids.znotice_source, kind: "response_to_topic", threadId: source })]);
  expect(await countUnreadNotifications(h.db, h.ids.znotice_source)).toBe(before + 1);
  expect(await notificationDestination(h.db, h.ids.znotice_source, rows[0].id, null)).toBe(`/t/${response}`);
  expect(await editEntry(h.db, h.ids.znotice_writer, response, { title: "Edited response", body: "@znotice_source Edited writing" })).toMatchObject({ ok: true });
  expect(await notices(response)).toHaveLength(1);
  const response2 = await topic("znotice_writer", source);
  const visible = (await listNotifications(h.db, h.ids.znotice_source)).items.filter(n => n.id === rows[0].id || n.entryId === response2);
  expect(groupThreadNotifications(visible)).toHaveLength(2);
});

it("never infers response context from a hand-written link, or notifies oneself", async () => {
  const source = await topic();
  expect(await notices(await topic("znotice_writer", undefined, `[Source](/t/${source})`))).toEqual([]);
  expect(await notices(await topic("znotice_source", source))).toEqual([]);
});

it.each(["en", "ja"] as const)("starts response excerpts after a %s interface opening, preserving literal body labels", async locale => {
  const source = await topic();
  expect(await editEntry(h.db, h.ids.znotice_source, source, { title: "Source_* [detail]", body: "Source material" })).toMatchObject({ ok: true });
  const prefill = await responsePostPrefill(h.db, String(source), locale);
  const response = await topic("znotice_writer", source, prefill!.prefill.body + "[Body\\_label \\[detail\\]](https://example.org)\n\nLater paragraph");
  const item = (await listNotifications(h.db, h.ids.znotice_source, { excerpts: true })).items.find(n => n.entryId === response);
  expect(item?.excerpt).toBe("Body_label [detail]");
  const openingOnly = await topic("znotice_writer", source, prefill!.prefill.body);
  expect((await listNotifications(h.db, h.ids.znotice_source, { excerpts: true })).items.find(n => n.entryId === openingOnly)?.excerpt).toBeNull();
  const ordinary = await topic("znotice_writer", undefined, prefill!.prefill.body + "@znotice_source Body");
  expect((await listNotifications(h.db, h.ids.znotice_source, { excerpts: true })).items.find(n => n.entryId === ordinary)?.excerpt).toContain("Source_* [detail]");
});

it("uses the translated body after its localized opening, or omits an opening-only excerpt", async () => {
  const source = await topic();
  const response = await topic("znotice_writer", source, responsePostLine(source, "Source", "znotice_source", "en") + "\n\nOriginal body");
  const [entry] = await h.db.select().from(entries).where(eq(entries.id, response));
  for (const rest of ["訳した本文。", ""]) {
    await h.db.insert(translations).values({ entryId: response, field: "body", lang: "ja", kind: "primary",
      text: responsePostLine(source, "訳した題", "znotice_source", "ja") + "\n\n" + rest, sourceHash: entry.sourceHash, mentionRevision: entry.mentionRevision })
      .onConflictDoUpdate({ target: [translations.entryId, translations.field, translations.lang, translations.kind], set: { text: responsePostLine(source, "訳した題", "znotice_source", "ja") + "\n\n" + rest } });
    const item = (await listNotifications(h.db, h.ids.znotice_source, { excerpts: true, display: { readLangs: ["ja"], displayLang: "ja" } })).items.find(n => n.entryId === response);
    expect(item?.excerpt).toBe(rest || null);
    expect(item?.excerptLang).toBe(rest ? "ja" : null);
  }
});

it("publishes browser response context directly and after an explicit draft save", async () => {
  const source = await topic();
  const { action } = await import("~/routes/topic-new");
  const path = `/t/new?respond=${source}`;
  const direct = await h.outcome(() => action(h.args(h.request(path, { as: "znotice_writer", form: { lang: "en", body: "Direct response" } }))));
  expect(direct.status).toBe(302);
  const id = Number(direct.location?.match(/^\/t\/(\d+)/)?.[1]);
  expect(await notices(id)).toEqual([expect.objectContaining({ kind: "response_to_topic", threadId: source })]);
  const saved = await h.outcome(() => action(h.args(h.request(path, { as: "znotice_writer", form: { intent: "draft", lang: "en", body: "Explicit draft" } }))));
  expect(saved.status).toBe(302);
  const draftId = Number(saved.location?.match(/^\/drafts\/(\d+)/)?.[1]);
  expect((await getDraft(h.db, h.ids.znotice_writer, draftId))?.responseTo).toBe(source);
  const published = await publishDraft(h.db, h.ids.znotice_writer, draftId);
  expect(published.ok).toBe(true);
  if (published.ok) expect(await notices(published.id)).toHaveLength(1);
});

it("suppresses hidden, deleted, closed, suspended and departed sources", async () => {
  const source = await topic();
  for (const field of ["hiddenAt", "deletedAt"] as const) {
    await h.db.update(entries).set({ [field]: new Date() }).where(eq(entries.id, source));
    expect(await notices(await topic("znotice_writer", source))).toEqual([]);
    await h.db.update(entries).set({ [field]: null }).where(eq(entries.id, source));
  }
  const [closed] = await h.db.insert(villages).values({ kind: "closed", name: "Unavailable source" }).returning();
  await h.db.update(entries).set({ villageId: closed.id }).where(eq(entries.id, source));
  expect(await notices(await topic("znotice_writer", source))).toEqual([]);
  await h.db.update(entries).set({ villageId: null }).where(eq(entries.id, source));
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 60_000) }).where(eq(profiles.userId, h.ids.znotice_source));
  expect(await notices(await topic("znotice_writer", source))).toEqual([]);
  await h.db.update(profiles).set({ suspendedUntil: null }).where(eq(profiles.userId, h.ids.znotice_source));
  await h.db.insert(user).values({ id: DELETED_MEMBER_ID, name: "", email: DELETED_MEMBER_EMAIL });
  await h.db.update(entries).set({ authorId: DELETED_MEMBER_ID }).where(eq(entries.id, source));
  expect(await notices(await topic("znotice_writer", source))).toEqual([]);
});

it("keeps draft response context through saves, conflict copies and authenticated recovery, excluding API and MCP", async () => {
  const source = await topic();
  const { action } = await import("~/routes/draft-autosave");
  const save = async (form: Record<string, string>, query = "") => {
    const response = await action(h.args(h.request(`/drafts/autosave${query}`, { as: "znotice_writer", form: { ownerId: h.ids.znotice_writer, kind: "topic", lang: "en", body: "Saved response", ...form } })));
    expect(response.status).toBe(200);
    return response.json();
  };
  const saved = await save({ newTopic: "1", responseTo: String(source) });
  const copy = await save({ draftId: String(saved.id), version: "1", fork: "1", responseTo: "99999999" });
  // Recovery is authenticated even after the original server row disappears.
  const original = (await getDraft(h.db, h.ids.znotice_writer, saved.id))!;
  const token = await draftRecoveryToken(h.db, h.ids.znotice_writer, original);
  await h.db.delete(drafts).where(eq(drafts.id, saved.id));
  const recovered = await save({ recoveryToken: token, responseTo: "99999999" }, "?newdraft=1");
  for (const id of [copy.id, recovered.id]) {
    expect((await getDraft(h.db, h.ids.znotice_writer, id))?.responseTo).toBe(source);
    const result = await publishDraft(h.db, h.ids.znotice_writer, id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(await notices(result.id)).toEqual([expect.objectContaining({ kind: "response_to_topic", threadId: source })]);
  }
  for (const aiSource of ["api", "mcp"] as const) {
    const result = await createDraft(h.db, h.ids.znotice_writer, { kind: "topic", lang: "en", body: "Tool draft", responseTo: source }, { via: "api", aiSource, responseTo: source });
    if (!result.ok) throw new Error(result.error);
    expect((await getDraft(h.db, h.ids.znotice_writer, result.id))?.responseTo).toBeNull();
    const published = await publishDraft(h.db, h.ids.znotice_writer, result.id);
    expect(published.ok).toBe(true);
    if (published.ok) expect(await notices(published.id)).toEqual([]);
  }
});

it("hides all source content and destinations when either post becomes unavailable", async () => {
  const source = await topic();
  const response = await topic("znotice_writer", source);
  const [notice] = await notices(response);
  for (const id of [source, response]) {
    for (const field of ["hiddenAt", "deletedAt"] as const) {
      await h.db.update(entries).set({ [field]: new Date() }).where(eq(entries.id, id));
      const item = (await listNotifications(h.db, h.ids.znotice_source, { excerpts: true })).items.find(n => n.id === notice.id);
      expect(item).toMatchObject({ unavailable: true, topicTitle: null, entryId: null, excerpt: null });
      expect(await notificationDestination(h.db, h.ids.znotice_source, notice.id, null)).toBeNull();
      await h.db.update(entries).set({ [field]: null }).where(eq(entries.id, id));
    }
  }
  const [closed] = await h.db.insert(villages).values({ kind: "closed", name: "Later unavailable" }).returning();
  for (const id of [source, response]) {
    await h.db.update(entries).set({ villageId: closed.id }).where(eq(entries.id, id));
    expect((await listNotifications(h.db, h.ids.znotice_source)).items.find(n => n.id === notice.id)?.unavailable).toBe(true);
    expect(await notificationDestination(h.db, h.ids.znotice_source, notice.id, null)).toBeNull();
    await h.db.update(entries).set({ villageId: null }).where(eq(entries.id, id));
  }
  expect(await h.db.select().from(notifications).where(and(eq(notifications.id, notice.id), eq(notifications.kind, "response_to_topic")))).toHaveLength(1);
});

it("applies the ordinary notification retention periods to response notices", async () => {
  const source = await topic();
  const response = await topic("znotice_writer", source);
  const [notice] = await notices(response);
  const now = new Date();
  await h.db.update(notifications).set({ readAt: new Date(now.getTime() - (RETENTION.readNotificationDays + 1) * 86_400_000) }).where(eq(notifications.id, notice.id));
  await runRetentionCleanup(h.db, now);
  expect(await notices(response)).toEqual([]);
});
