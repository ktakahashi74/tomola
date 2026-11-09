import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReply, createTopic } from "~/lib/entries.server";
import { hideEntry } from "~/lib/moderation.server";
import { grantModerator } from "~/lib/roles.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// New state-changing actions reject cross-origin requests with 403 and no changes; assertSameOrigin runs first, in addition to router checks.
let h: RouteHarness;
let topicId: number;
let actionId: number;
const saved = process.env.OPERATOR_EMAILS;

beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "opal@example.com";
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja" });
  await h.signIn("opal", { homeArea: "ja" });
  await h.signIn("rina", { homeArea: "ja" });
  await grantModerator(h.db, h.ids.opal, h.ids.rina, "ja");
  const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "話題", body: "本文" });
  if (!t.ok) throw new Error("topic failed");
  topicId = t.id;
  await createReply(h.db, h.ids.rina, topicId, { lang: "ja", body: "返信" });
  const hid = await hideEntry(h.db, { id: h.ids.opal, scope: { operator: true, langs: [] } }, { entryId: topicId, reason: "spam", note: "n" });
  if (!hid.ok) throw new Error("hide failed");
  actionId = hid.actionId;
});
afterAll(() => {
  h.restore();
  if (saved === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = saved;
});

describe("the new actions refuse a foreign origin", () => {
  const foreign = { origin: "https://evil.example" };
  it("for /mod, /mod/appeals, /admin/roles, /appeal, /notifications and /t/:id/edit, and change nothing", async () => {
    const cases: Array<[string, () => Promise<{ action: (a: never) => unknown }>, string, string, Record<string, string>, Record<string, string>]> = [
      ["mod", () => import("~/routes/mod") as never, "/mod", "rina", { intent: "unhide", entryId: String(topicId), reason: "other" }, {}],
      ["mod-appeals", () => import("~/routes/mod-appeals") as never, "/mod/appeals", "rina", { appealId: "1", intent: "uphold", note: "x" }, {}],
      ["admin-roles", () => import("~/routes/admin-roles") as never, "/admin/roles", "opal", { intent: "grant", userId: "x", lang: "ja" }, {}],
      ["appeal", () => import("~/routes/appeal") as never, `/appeal/${actionId}`, "hana", { text: "unfair" }, { actionId: String(actionId) }],
      ["notifications", () => import("~/routes/notifications") as never, "/notifications", "hana", { intent: "read-all" }, {}],
      // topic-edit is the entry point of the author's edit and of the moderator's fix (fix_entry)
      ["topic-edit", () => import("~/routes/topic-edit") as never, `/t/${topicId}/edit`, "hana", { title: "changed", body: "changed" }, { id: String(topicId) }],
    ];
    for (const [name, load, path, as, form, params] of cases) {
      const mod = await load();
      const res = await h.outcome(() => mod.action(h.args(h.request(path, { as, form, headers: foreign }), params)));
      expect(res, name).toMatchObject({ status: 403 });
    }
    const { entries, appeals, roles } = await import("~/lib/db/schema");
    expect((await h.db.select().from(entries).where((await import("drizzle-orm")).eq(entries.id, topicId)))[0]).toMatchObject({ title: "話題", body: "本文" });
    expect((await h.db.select().from(entries).where((await import("drizzle-orm")).eq(entries.id, topicId)))[0].hiddenAt).not.toBeNull();
    expect(await h.db.select().from(appeals)).toEqual([]);
    expect((await h.db.select().from(roles)).filter((r) => r.role === "moderator")).toHaveLength(1);
  });
});
