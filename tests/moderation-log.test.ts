import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReply, createTopic } from "~/lib/entries.server";
import { createReport, hideEntry, listPublicLog, suspendMember, unhideEntry, dismissReports } from "~/lib/moderation.server";
import { grantModerator } from "~/lib/roles.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Public moderation records expose only type, reason, language, and date.
// No actor, reporter, note, affected member, post ID, or link.
let h: RouteHarness;
const OP = { operator: true, langs: [] };
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));
let ja: number;
let en: number;

beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "";
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  await h.signIn("reporterx", { homeArea: "ja", readLangs: ["ja", "en"] });
  await h.signIn("moriko", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("zoe", { homeArea: "ja", readLangs: ["ja"] });
  await grantModerator(h.db, h.ids.moriko, h.ids.moriko, "ja").catch(() => undefined);
  const a = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "TOPIC-TITLE-JA", body: "BODY-JA" });
  const b = await createTopic(h.db, h.ids.hana, { lang: "en", title: "TOPIC-TITLE-EN", body: "BODY-EN" });
  if (!a.ok || !b.ok) throw new Error("topic failed");
  ja = a.id;
  en = b.id;
  const rep = await createReply(h.db, h.ids.hana, a.id, { lang: "ja", body: "reply" });
  if (!rep.ok) throw new Error("reply failed");
  await createReport(h.db, h.ids.reporterx, { entryId: ja, reason: "spam", note: "REPORTER-NOTE" });
  await createReport(h.db, h.ids.reporterx, { entryId: en, reason: "harassment", note: "REPORTER-NOTE-2" });
  const actor = { id: h.ids.moriko, scope: OP };
  await hideEntry(h.db, actor, { entryId: ja, reason: "spam", note: "SECRET-MODERATOR-NOTE" }, { now: day(1) });
  await unhideEntry(h.db, actor, { entryId: ja, reason: "other", note: "SECRET-UNHIDE-NOTE" }, { now: day(2) });
  await hideEntry(h.db, actor, { entryId: en, reason: "harassment", note: "SECRET-NOTE-EN" }, { now: day(3) });
  await suspendMember(h.db, actor, { userId: h.ids.zoe, reason: "infohazard", note: "SECRET-SUSPEND-NOTE", days: 5 }, { now: day(4) });
  // Dismissed reports are visible; explanations are not.
  const c = await createTopic(h.db, h.ids.hana, { lang: "en", title: "TOPIC-TITLE-FR", body: "BODY-FR" });
  if (!c.ok) throw new Error("topic failed");
  await createReport(h.db, h.ids.reporterx, { entryId: c.id, reason: "other", note: "REPORTER-NOTE-3" });
  const dismissed = await dismissReports(h.db, actor, { entryId: c.id, reason: "other", note: "SECRET-DISMISS-NOTE" }, { now: day(5) });
  if (!dismissed.ok) throw new Error("dismiss failed");
});
afterAll(() => {
  h.restore();
  delete process.env.OPERATOR_EMAILS;
});

describe("the public moderation log", () => {
  it("lists each action newest first with the action, the reason, the language of the post (none for a member) and the date, and nothing else", async () => {
    const log = await listPublicLog(h.db);
    expect(log.entries).toEqual([
      { action: "dismiss_report", reason: "other", lang: "en", date: "2026-10-05" },
      { action: "suspend", reason: "infohazard", lang: null, date: "2026-10-04" },
      { action: "hide", reason: "harassment", lang: "en", date: "2026-10-03" },
      { action: "unhide", reason: "other", lang: "ja", date: "2026-10-02" },
      { action: "hide", reason: "spam", lang: "ja", date: "2026-10-01" },
    ]);
    expect(log).toMatchObject({ page: 1, hasNext: false });
  });

  it("never shows who acted, who reported, the notes, the member's name or the post, in the page data or in the rendered page", async () => {
    const { loader } = await import("~/routes/moderation");
    const res = await h.outcome(async () => (await loader(h.args(h.request("/moderation", { as: "hana" })))));
    expect(res.status).toBe(200);
    const data = res.value as { entries: Array<Record<string, unknown>> };
    for (const e of data.entries) expect(Object.keys(e).sort()).toEqual(["action", "date", "lang", "reason"]);
    const json = JSON.stringify(data);
    for (const secret of ["SECRET-", "REPORTER-NOTE", "moriko", "reporterx", "zoe", "hana", "TOPIC-TITLE", "BODY-", h.ids.moriko, h.ids.reporterx, h.ids.zoe, h.ids.hana]) {
      expect(json, secret).not.toContain(secret);
    }
    // The rendered page also uses only loader data.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { createMemoryRouter, RouterProvider } = await import("react-router");
    const Page = (await import("~/routes/moderation")).default;
    const router = createMemoryRouter([{ path: "/moderation", element: createElement(Page, { loaderData: data, actionData: undefined, params: {}, matches: [] } as never) }], { initialEntries: ["/moderation"] });
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    expect(html).toContain("2026-10-04");
    for (const secret of ["SECRET-", "REPORTER-NOTE", "moriko", "reporterx", "hana", "TOPIC-TITLE", "BODY-", `/t/${ja}`, `#p-${ja}`]) expect(html, secret).not.toContain(secret);
  });

  it("is for logged-in members (visitors go to the login) and is open to a suspended member", async () => {
    const { loader } = await import("~/routes/moderation");
    expect(await h.outcome(async () => (await loader(h.args(h.request("/moderation")))))).toMatchObject({ status: 302, location: "/login?next=%2Fmoderation" });
    expect((await h.outcome(async () => (await loader(h.args(h.request("/moderation", { as: "zoe" })))))).status).toBe(200);
  });

  it("is paged, newest first", async () => {
    const p1 = await listPublicLog(h.db, { limit: 3 });
    const p2 = await listPublicLog(h.db, { limit: 3, page: 2 });
    expect([p1.entries.length, p1.hasNext, p2.entries.length, p2.hasNext]).toEqual([3, true, 2, false]);
    expect(p2.entries.map((e) => e.date)).toEqual(["2026-10-02", "2026-10-01"]);
    const { loader } = await import("~/routes/moderation");
    expect((await h.outcome(async () => (await loader(h.args(h.request("/moderation?page=0", { as: "hana" })))))).status).toBe(404);
  });
});
