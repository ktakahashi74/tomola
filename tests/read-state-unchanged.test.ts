import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatReads, notifications } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { clearMemoryReadLimitsForTests } from "~/lib/rate-limit.server";
import { createApiToken } from "~/lib/tokens.server";
import { getMd } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Reading through a Markdown twin or the API never changes a member's viewing state, whoever (a person or an AI tool) fetches it.
// The stored rows are compared, not the responses. Opening a notification on the screen still marks it read (tests/notification-opening.test.ts).
let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("somchai", { homeArea: "th", readLangs: ["th", "ja"] });
});
afterAll(() => h.restore());

describe("read routes with a member's credentials", () => {
  it("leave the stored notifications and chat positions as they were", async () => {
    const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "既読の確かめ", body: "本文" });
    if (!t.ok) throw new Error(t.error);
    const r = await createReply(h.db, h.ids.somchai, t.id, { lang: "th", body: "ตอบ" });
    if (!r.ok) throw new Error(r.error);
    const token = await createApiToken(h.db, h.ids.hana, { name: "reader", kind: "read" });
    if (!token.ok) throw new Error(token.error);
    const stored = async () => ({
      notifications: await h.db.select().from(notifications).where(eq(notifications.userId, h.ids.hana)).orderBy(notifications.id),
      chatReads: await h.db.select().from(chatReads).where(eq(chatReads.userId, h.ids.hana)),
    });
    const before = await stored();
    expect(before.notifications.some((row) => row.readAt === null)).toBe(true);
    clearMemoryReadLimitsForTests(h.db);
    for (const path of [`/t/${t.id}.md?k=${token.token}`, `/t/${t.id}.md?lang=all&k=${token.token}`, `/t/${t.id}.md?page=1`, `/latest.md`, `/home.md`, `/a/ja.md`]) {
      const res = await getMd(h, path, path.includes("k=") ? {} : { as: "hana" });
      expect(res.status, path).toBe(200);
      await res.text();
    }
    const { loader: changes } = await import("~/routes/changes-md");
    const feed = await changes(h.args(h.request(`/changes.md?since=2020-01-01T00:00:00Z&k=${token.token}`)));
    expect((feed as Response).status).toBe(200);
    expect(await stored()).toEqual(before);
  });
});
