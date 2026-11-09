import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { profiles, reports, villageMembers, villages } from "~/lib/db/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { createAppeal, decideAppeal } from "~/lib/appeals.server";
import { moderateWithCurrentVersion } from "./helpers/village-moderation";
import { createVillageReport } from "~/lib/village-moderation.server";
import Appeal, { loader as appealLoader } from "~/routes/appeal";
import ModerationLog, { loader as logLoader } from "~/routes/moderation";
import Notifications, { loader as notificationsLoader } from "~/routes/notifications";
import { m } from "~/paraglide/messages.js";
import { reasonLabel } from "~/components/reason-label";
import { createVillage } from "~/lib/village-management.server";
import { ensureLanguageVillages } from "~/lib/villages.server";
import { action as villageAction, loader as villageLoader } from "~/routes/village";
import { action as directAction, loader as directLoader, shouldRevalidate as directRevalidate } from "~/routes/mod-village";
import { loader as layoutLoader } from "~/routes/member-layout";
import { action as modAction, shouldRevalidate as modRevalidate } from "~/routes/mod";
import { MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { seedRateLimit } from "./helpers/fixtures";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
beforeAll(async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("PUBLIC_READING", "1");
  h = await setupRouteHarness();
  await ensureLanguageVillages(h.db);
  for (const name of ["vr_owner", "vr_reporter", "vr_operator", "vr_suspended"]) await h.signIn(name, { homeArea: "en" });
  await h.signIn("vr_halfway", { profile: false });
  await h.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, h.ids.vr_suspended));
  await createVillage(h.db, h.ids.vr_owner, { slug: "reported-route", name: "Reported route", kind: "open", description: "Public description" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.stubEnv("VILLAGES", "1"); vi.stubEnv("PUBLIC_READING", "1"); });
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });
const post = (as?: string, headers?: Record<string, string>, slug = "reported-route") => h.outcome(() => villageAction(h.args(h.request(`/v/${slug}`, { as, form: { intent: "flag", reason: "spam", note: "Evidence" }, headers }), { slug })));
function render(Component: unknown, path: string, loaderData: unknown) {
  const router = createMemoryRouter([{ path, element: createElement(Component as never, { loaderData, actionData: undefined, params: {}, matches: [] } as never) }], { initialEntries: [path] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
it("revalidates stale village forms after an error while preserving other moderation revalidation", () => {
  const args: ShouldRevalidateFunctionArgs = { currentUrl: new URL("http://localhost/mod"), nextUrl: new URL("http://localhost/mod"), currentParams: {}, nextParams: {}, actionStatus: 409, actionResult: { error: "stale" }, defaultShouldRevalidate: false };
  for (const revalidate of [modRevalidate, directRevalidate]) {
    expect(revalidate(args)).toBe(true);
    expect(revalidate({ ...args, actionResult: { error: "invalid_state" } })).toBe(false);
    expect(revalidate({ ...args, actionResult: undefined, defaultShouldRevalidate: true })).toBe(true);
  }
});
describe("village report entry and moderation gates", () => {
  it("keeps the off switch before authentication and closes new submissions", async () => {
    vi.stubEnv("VILLAGES", "");
    for (const as of [undefined, "vr_owner", "vr_halfway"]) expect(await post(as)).toMatchObject({ status: 404 });
  });
  it("uses writer and same-origin gates and does not expose the form state to anonymous readers", async () => {
    expect(await post("vr_halfway")).toMatchObject({ status: 302, location: "/onboarding" });
    expect(await post("vr_suspended")).toMatchObject({ status: 302, location: "/suspended" });
    expect(await post("vr_owner", { origin: "https://another.test" })).toMatchObject({ status: 403 });
    expect(await post()).toMatchObject({ status: 302 });
    expect(await villageLoader(h.args(h.request("/v/reported-route"), { slug: "reported-route" }))).not.toHaveProperty("reported");
    expect(await post("vr_reporter")).toMatchObject({ status: 200 });
    const page = await villageLoader(h.args(h.request("/v/reported-route", { as: "vr_reporter" }), { slug: "reported-route" }));
    expect(page).toMatchObject({ reported: ["information"] });
    expect(await post("vr_reporter")).toMatchObject({ status: 409 });
  });
  it("shares the existing post-report rate budget", async () => {
    await seedRateLimit(h.db, `member:report:${h.ids.vr_owner}`, MEMBER_RATE_LIMITS.report);
    expect(await post("vr_owner")).toMatchObject({ status: 429 });
    expect(await h.db.select().from(reports).where(eq(reports.reporterId, h.ids.vr_owner))).toEqual([]);
  });
  it("blocks non-owner operator shortcuts and non-operator moderation submissions", async () => {
    vi.stubEnv("OPERATOR_EMAILS", "vr_operator@example.com");
    const page = await villageLoader(h.args(h.request("/v/reported-route?end=confirm", { as: "vr_operator" }), { slug: "reported-route" }));
    expect(page.confirmingEnd).toBeFalsy();
    for (const form of [{ intent: "edit", name: "Unrecorded", description: "" }, { intent: "end", confirm: "end" }] as Array<Record<string, string>>)
      expect(await h.outcome(() => villageAction(h.args(h.request("/v/reported-route", { as: "vr_operator", form }), { slug: "reported-route" })))).toMatchObject({ status: 403 });
    for (const intent of ["village-fix", "village-end", "village-dismiss"]) {
      expect(await h.outcome(() => modAction(h.args(h.request("/mod", { as: "vr_reporter", form: { intent, reportId: "1", reason: "spam", note: "Denied", confirm: "1" } }))))).toMatchObject({ status: 404 });
      expect(await h.outcome(() => modAction(h.args(h.request("/mod", { as: "vr_halfway", form: { intent } }))))).toMatchObject({ status: 302, location: "/onboarding" });
    }
    expect((await h.db.select().from(villages).where(eq(villages.slug, "reported-route")))[0]).toMatchObject({ name: "Reported route", endedAt: null });
  });
});

it("renders former and current owners' appeal headings, before-values and reversal notices", async () => {
  const slug = "appeal-view-route";
  const actor = { id: h.ids.vr_operator, scope: { operator: true, langs: [] } };
  await createVillage(h.db, h.ids.vr_owner, { slug, name: "Before correction", kind: "open", description: "Before description" });
  const [village] = await h.db.select().from(villages).where(eq(villages.slug, slug));
  await h.db.insert(villageMembers).values({ villageId: village.id, userId: h.ids.vr_reporter, role: "owner" });
  const corrected = await moderateWithCurrentVersion(h.db, actor, { slugTarget: slug, intent: "fix", name: "After correction", reason: "spam", note: "Correction explanation" });
  if (!corrected.ok) throw new Error(corrected.error);
  const filed = await createAppeal(h.db, h.ids.vr_owner, corrected.actionId, "A filed appeal");
  if (!filed.ok) throw new Error(filed.error);
  // Remove the appellant's ownership after filing; the other owner remains.
  await h.db.delete(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, h.ids.vr_owner)));
  const load = (as: string) => appealLoader(h.args(h.request(`/appeal/${corrected.actionId}`, { as }), { actionId: String(corrected.actionId) }));
  const former = render(Appeal, `/appeal/${corrected.actionId}`, await load("vr_owner"));
  expect(former).toContain(m.appeal_yours());
  expect(former).toContain(m.village_before_correction());
  expect(former).not.toContain(m.village_report_snapshot());
  const shared = render(Appeal, `/appeal/${corrected.actionId}`, await load("vr_reporter"));
  expect(shared).toContain(m.village_appeal_shared());
  expect(shared).not.toContain(m.appeal_yours());
  await h.signIn("vr_independent", { homeArea: "en" });
  const decided = await decideAppeal(h.db, { id: h.ids.vr_independent, scope: actor.scope }, filed.id, { decision: "overturned", note: "Independent decision" });
  expect(decided).toMatchObject({ ok: true, reversed: true });
  expect(render(Appeal, `/appeal/${corrected.actionId}`, await load("vr_owner"))).toContain(m.appeal_status_overturned());
  const notices = render(Notifications, "/notifications", await notificationsLoader(h.args(h.request("/notifications", { as: "vr_reporter" }))));
  expect(notices).toContain(m.notification_moderation_unfix_village());
  expect(notices).not.toContain("Appeal #");
  expect(notices).not.toContain(m.notification_reason({ reason: reasonLabel("other") }));
  const reported = await createVillageReport(h.db, h.ids.vr_owner, { slug, reason: "other" });
  if (!reported.ok) throw new Error(reported.error);
  expect(await moderateWithCurrentVersion(h.db, actor, { reportId: reported.id, intent: "dismiss", reason: "other" })).toMatchObject({ ok: true });
  const openLog = render(ModerationLog, "/moderation", await logLoader(h.args(h.request("/moderation", { as: "vr_reporter" }))));
  const dismissedRow = openLog.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)?.find(row => row.includes(m.log_action_dismiss_village_report()));
  expect(dismissedRow).toBeDefined();
  expect(dismissedRow).not.toContain("Before correction");
  expect(dismissedRow).not.toContain('href="/v/');
  // Existing records stay readable after disabling the village pages.
  vi.stubEnv("VILLAGES", "");
  const loaded = await logLoader(h.args(h.request("/moderation", { as: "vr_reporter" })));
  const html = render(ModerationLog, "/moderation", loaded);
  expect(html).toContain("Before correction");
  expect(html).not.toContain('href="/v/appeal-view-route"');
});


describe("direct village moderation route", () => {
  it("returns the same missing-page response from loader, action and parent while disabled", async () => {
    vi.stubEnv("VILLAGES", "");
    for (const as of [undefined, "vr_operator", "vr_halfway"]) for (const run of [
      () => directLoader(h.args(h.request("/mod/village/reported-route", { as }), { slug: "reported-route" })),
      () => directAction(h.args(h.request("/mod/village/reported-route", { as, form: { intent: "village-fix" } }), { slug: "reported-route" })),
      () => layoutLoader({ request: h.request("/mod/village/reported-route", { as }) }),
    ]) expect(await h.outcome(run)).toMatchObject({ status: 404 });
  });
  it("applies operator, writer and same-origin gates to the new entry", async () => {
    vi.stubEnv("OPERATOR_EMAILS", "vr_operator@example.com,vr_suspended@example.com");
    const path = "/mod/village/reported-route";
    expect(await h.outcome(() => directLoader(h.args(h.request(path, { as: "vr_reporter" }), { slug: "reported-route" })))).toMatchObject({ status: 404 });
    expect(await h.outcome(() => directAction(h.args(h.request(path, { as: "vr_halfway", form: { intent: "village-fix" } }), { slug: "reported-route" })))).toMatchObject({ status: 302, location: "/onboarding" });
    expect(await h.outcome(() => directAction(h.args(h.request(path, { as: "vr_suspended", form: { intent: "village-fix" } }), { slug: "reported-route" })))).toMatchObject({ status: 302, location: "/suspended" });
    expect(await h.outcome(() => directAction(h.args(h.request(path, { as: "vr_operator", form: { intent: "village-fix" }, headers: { origin: "https://another.test" } }), { slug: "reported-route" })))).toMatchObject({ status: 403 });
    const found = await directLoader(h.args(h.request(path, { as: "vr_operator" }), { slug: "reported-route" }));
    expect(found.card).toMatchObject({ village: { name: "Reported route" }, owned: false });
    expect(found.card.version).toMatch(/^\d+$/);
    expect(JSON.stringify(found)).not.toMatch(/"villageId"|"ownerId"/);
  });
});
