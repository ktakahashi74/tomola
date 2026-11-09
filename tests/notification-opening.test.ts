import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createElement } from "react";
import { entries, notifications } from "~/lib/db/schema";
import { setFollow } from "~/lib/follows.server";
import { followedThreadHrefs } from "~/lib/reply-locations.server";
import { createReply, createTopic } from "~/lib/entries.server";
import Notifications, { action, loader } from "~/routes/notifications";
import { renderInRouter } from "./helpers/render-in-router";
import { loader as openLink } from "~/routes/notification-open";
import { countUnreadNotifications } from "~/lib/notifications.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
let h: RouteHarness, topic: number, notice: number;
beforeAll(async () => {
  h = await setupRouteHarness(); await h.signIn("notice_reader"); await h.signIn("notice_author");
  const made = await createTopic(h.db, h.ids.notice_reader, { lang: "ja", title: "Notification destination", body: "Topic" });
  if (!made.ok) throw new Error("Topic creation failed"); topic = made.id;
  const reply = await createReply(h.db, h.ids.notice_author, topic, { lang: "ja", body: "Notified reply" });
  if (!reply.ok) throw new Error("Reply creation failed");
  [notice] = (await h.db.select().from(notifications).where(eq(notifications.userId, h.ids.notice_reader))).map(row => row.id);
});
afterAll(() => h.restore());
it("rejects obsolete open POSTs without marking a notification read", async () => {
  const result = await h.outcome(() => action(h.args(h.request("/notifications", { as: "notice_reader", form: { intent: "open", id: String(notice) } }))));
  expect(result.status).toBe(400);
  expect(await countUnreadNotifications(h.db, h.ids.notice_reader)).toBe(1);
});
it("keeps cross-site bulk marking from changing read state", async () => {
  await h.db.update(notifications).set({ readAt: null }).where(eq(notifications.id, notice));
  const result = await h.outcome(() => action(h.args(h.request("/notifications", { as: "notice_reader", headers: { Origin: "https://other.example" }, form: { intent: "read-all" } }))));
  expect(result.status).toBe(403); expect(await countUnreadNotifications(h.db, h.ids.notice_reader)).toBe(1);
});
it("renders an ordinary link that can open independently of scripts or form submission", async () => {
  const loaderData = await loader(h.args(h.request("/notifications", { as: "notice_reader" })));
  const html = await renderInRouter(() => createElement(Notifications, { loaderData } as never), "/notifications");
  expect(html).toMatch(new RegExp(`<a[^>]*href="/notifications/${notice}/open"`));
  expect(html).not.toContain('role="link"');
});
it("marks the owner's notification read on a document GET and prevents redirect caching", async () => {
  await h.db.update(notifications).set({ readAt: null }).where(eq(notifications.id, notice));
  const response = await openLink(h.args(h.request(`/notifications/${notice}/open?href=https://other.example`, { as: "notice_reader" }), { id: String(notice) }));
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toMatch(new RegExp(`^/t/${topic}#c-`));
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await countUnreadNotifications(h.db, h.ids.notice_reader)).toBe(0);
});
it("never opens another member's notification or consumes read state from speculative requests", async () => {
  await h.db.update(notifications).set({ readAt: null }).where(eq(notifications.id, notice));
  expect((await h.outcome(() => openLink(h.args(h.request(`/notifications/${notice}/open`, { as: "notice_author" }), { id: String(notice) })))).status).toBe(404);
  for (const headers of [{ Purpose: "prefetch" }, { "Sec-Purpose": "prefetch;prerender" }, { "Sec-Fetch-Site": "cross-site" }] as Array<Record<string, string>>) {
    const response = await openLink(h.args(h.request(`/notifications/${notice}/open`, { as: "notice_reader", headers }), { id: String(notice) }));
    expect(response.status).toBe(302);
    expect(await countUnreadNotifications(h.db, h.ids.notice_reader)).toBe(1);
  }
  const head = new Request(h.request(`/notifications/${notice}/open`, { as: "notice_reader" }), { method: "HEAD" });
  expect((await openLink(h.args(head, { id: String(notice) }))).status).toBe(302);
  expect(await countUnreadNotifications(h.db, h.ids.notice_reader)).toBe(1);
});
it("requires a member and rejects invalid notification IDs", async () => {
  expect((await h.outcome(() => openLink(h.args(h.request(`/notifications/${notice}/open`), { id: String(notice) })))).status).toBe(302);
  for (const id of ["0", "bad", "1.5"]) {
    expect((await h.outcome(() => openLink(h.args(h.request(`/notifications/${id}/open`, { as: "notice_reader" }), { id })))).status).toBe(400);
  }
});

it("opens the first readable new reply on its page when the first notified reply is unavailable", async () => {
  await h.signIn("notice_follow");
  await h.signIn("notice_other_follow");
  const made = await createTopic(h.db, h.ids.notice_author, { lang: "en", title: "Unread range", body: "Topic" });
  if (!made.ok) throw new Error(made.error);
  await h.db.insert(entries).values(Array.from({ length: 99 }, () => ({ kind: "reply", threadId: made.id, authorId: h.ids.notice_author, lang: "en", body: "Earlier reply" })));
  await setFollow(h.db, h.ids.notice_follow, made.id, true);
  await setFollow(h.db, h.ids.notice_other_follow, made.id, true);
  const replies: number[] = [];
  let ownReply = 0;
  for (let i = 0; i < 3; i++) {
    const result = await createReply(h.db, h.ids.notice_author, made.id, { lang: "en", body: `Unread reply ${i}` });
    if (!result.ok) throw new Error(result.error);
    replies.push(result.id);
    if (i === 0) {
      const own = await createReply(h.db, h.ids.notice_follow, made.id, { lang: "en", body: "My own reply is not an unread notification" });
      if (!own.ok) throw new Error(own.error);
      ownReply = own.id;
    }
  }
  const rows = await h.db.select().from(notifications).where(inArray(notifications.userId, [h.ids.notice_follow, h.ids.notice_other_follow]));
  const row = rows.find(r => r.userId === h.ids.notice_follow)!;
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, replies[0]));
  const response = await openLink(h.args(h.request(`/notifications/${row.id}/open`, { as: "notice_follow" }), { id: String(row.id) }));
  expect(response.headers.get("Location")).toBe(`/t/${made.id}?page=2#c-${replies[1]}`);
  const hrefs = await followedThreadHrefs(h.db, rows);
  expect(hrefs.get(row.id)).toBe(`/t/${made.id}?page=2#c-${replies[1]}`);
  expect(hrefs.get(rows.find(r => r.userId === h.ids.notice_other_follow)!.id)).toBe(`/t/${made.id}?page=2#c-${ownReply}`);
});

it("ranks only topics with replacement replies on the second lookup", async () => {
  const rankings: unknown[][] = [];
  const db = await createTestDb({ logger: { logQuery(query, params) { if (query.includes("row_number()")) rankings.push(params); } } });
  await addMember(db, "range_reader", "range_reader");
  await addMember(db, "range_author", "range_author");
  const topics = await db.insert(entries).values(["A", "B", "C"].map(title => ({ kind: "topic", authorId: "range_author", lang: "en", title, body: title }))).returning();
  const rows = [];
  const expected: string[] = [];
  for (const [index, topic] of topics.entries()) {
    const replies = await db.insert(entries).values([0, 1].map(i => ({ kind: "reply", threadId: topic.id, authorId: "range_author", lang: "en", body: "Reply", hiddenAt: index < 2 && i === 0 ? new Date() : null }))).returning();
    const [row] = await db.insert(notifications).values({ userId: "range_reader", kind: "followed_thread", threadId: topic.id, firstEntryId: replies[0].id, entryId: replies[1].id }).returning();
    rows.push(row);
    expected.push(`/t/${topic.id}#c-${replies[index < 2 ? 1 : 0].id}`);
  }
  const destinations = await followedThreadHrefs(db, rows);
  expect(rows.map(row => destinations.get(row.id))).toEqual(expected);
  expect(rankings).toHaveLength(2);
  expect(rankings[0]).toContain(topics[2].id);
  expect(rankings[1]).toContain(topics[0].id);
  expect(rankings[1]).toContain(topics[1].id);
  expect(rankings[1]).not.toContain(topics[2].id);
});
