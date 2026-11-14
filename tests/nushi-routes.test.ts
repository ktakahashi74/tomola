import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createTopic } from "~/lib/entries.server";
import { nushiAnswers, nushiReports, nushiRequests } from "~/lib/db/schema";
import { personalVillage } from "~/lib/personal-villages.server";
import { setVillageNushi } from "~/lib/nushi-settings.server";
import { processNushiRequest } from "~/lib/nushi.server";
import { action } from "~/routes/nushi-action";
import { loader as read } from "~/routes/nushi-read";
import { loader as reports } from "~/routes/nushi-reports";

let h: RouteHarness, answerId: number;
beforeAll(async () => {
  h = await setupRouteHarness();
  vi.stubEnv("VILLAGE_NUSHI", "1"); vi.stubEnv("VILLAGES", "1"); vi.stubEnv("PUBLIC_READING", "1");
  await h.signIn("znushi_route_owner", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("znushi_route_reader", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("znushi_route_operator", { homeArea: "en", readLangs: ["en"] });
  const village = await personalVillage(h.db, h.ids.znushi_route_owner);
  await setVillageNushi(h.db, h.ids.znushi_route_owner, village!.id, true);
  await createTopic(h.db, h.ids.znushi_route_owner, { body: "Orchard public source for the route boundary.", lang: "en" });
  const topic = await createTopic(h.db, h.ids.znushi_route_owner, { body: "@nushi orchard", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  const [request] = await h.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, topic.id));
  await processNushiRequest(h.db, request.id);
  const [answer] = await h.db.select().from(nushiAnswers); answerId = answer.id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await h.restore(); vi.unstubAllEnvs(); });

it("allows anonymous public reads, marks the author as AI, and uses no-store", async () => {
  const response = await read(h.args(h.request(`/nushi/${answerId}.json?lang=en`), { id: String(answerId) }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
  const value = await response.json(); expect(value).toMatchObject({ authorKind: "ai", author: "Nushi", hidden: false });
  expect(JSON.stringify(value)).not.toContain(h.ids.znushi_route_owner);
});
it("requires member authorization and same-origin requests before accepting a report", async () => {
  const form = { intent: "report", answerId: String(answerId), kind: "moderation", reason: "other" };
  expect((await h.outcome(() => action(h.args(h.request("/nushi/action", { form }))))).status).toBe(302);
  const foreign = h.request("/nushi/action", { as: "znushi_route_reader", form, headers: { origin: "https://elsewhere.example" } });
  expect((await h.outcome(() => action(h.args(foreign)))).status).toBe(403);
  expect(await h.db.select().from(nushiReports)).toHaveLength(0);
});
it("hides report entry points when disabled without outstanding reports", async () => {
  const { loader: mod } = await import("~/routes/mod");
  const { loader: moderation } = await import("~/routes/moderation");
  vi.stubEnv("OPERATOR_EMAILS", "znushi_route_operator@example.com");
  vi.stubEnv("VILLAGE_NUSHI", "");
  try {
    expect((await mod(h.args(h.request("/mod", { as: "znushi_route_operator" })))).nushi).toBeNull();
    for (const member of ["znushi_route_operator", "znushi_route_reader"]) expect((await moderation(h.args(h.request("/moderation", { as: member })))).nushi).toBe(false);
    const { nushiReportsAvailable } = await import("~/lib/nushi-reports.server");
    const select = vi.fn(() => { throw new Error("Disabled member links must not query reports"); });
    expect(await nushiReportsAvailable({ select } as unknown as typeof h.db, false)).toBe(false);
    expect(select).not.toHaveBeenCalled();
  } finally { vi.stubEnv("VILLAGE_NUSHI", "1"); }
});
it("saves no error evidence without consent, and keeps moderation behind the operator boundary", async () => {
  const form = { intent: "report", answerId: String(answerId), kind: "error", reason: "wrong_post", returnTo: "/nushi/reports" };
  expect((await h.outcome(() => action(h.args(h.request("/nushi/action", { as: "znushi_route_reader", form }))))).status).toBe(400);
  expect((await h.outcome(() => action(h.args(h.request("/nushi/action", { as: "znushi_route_reader", form: { ...form, consent: "1" } }))))).status).toBe(302);
  const [report] = await h.db.select().from(nushiReports); expect(report.evidence).toBeTruthy();
  const denied = await h.outcome(() => action(h.args(h.request("/nushi/action", { as: "znushi_route_reader", form: { intent: "moderate", reportId: String(report.id), hide: "1", note: "A proposed resolution." } }))));
  expect(denied.status).toBe(403);
  const own = await reports(h.args(h.request(`/nushi/reports?evidence=${report.id}`, { as: "znushi_route_reader" })));
  expect(own.evidence).toBeNull(); expect(own.reports).toHaveLength(1);
  vi.stubEnv("OPERATOR_EMAILS", "znushi_route_operator@example.com");
  const operator = await reports(h.args(h.request(`/nushi/reports?evidence=${report.id}`, { as: "znushi_route_operator" })));
  expect(operator.evidence).toContain("Orchard public source");
  expect(operator.reports[0]).not.toHaveProperty("reporterId");
  const { loader: mod } = await import("~/routes/mod");
  const { loader: moderation } = await import("~/routes/moderation");
  vi.stubEnv("VILLAGE_NUSHI", "");
  try {
    expect((await mod(h.args(h.request("/mod", { as: "znushi_route_operator" })))).nushi).not.toBeNull();
    expect((await moderation(h.args(h.request("/moderation", { as: "znushi_route_operator" })))).nushi).toBe(true);
    expect((await moderation(h.args(h.request("/moderation", { as: "znushi_route_reader" })))).nushi).toBe(false);
  } finally { vi.stubEnv("VILLAGE_NUSHI", "1"); }
});
it("keeps visitor hiding on the device and member hiding in the account", async () => {
  const visitor = await h.outcome(() => action(h.args(h.request("/nushi/action", { form: { intent: "visitor-hide", hide: "1", returnTo: `/nushi/${answerId}` } }))));
  expect(visitor.status).toBe(302);
  const preference = await h.outcome(() => action(h.args(h.request("/nushi/action", { as: "znushi_route_reader", form: { intent: "preferences", hide: "1", citations: "0", returnTo: "https://elsewhere.example" } }))));
  expect(preference.status).toBe(302); expect(preference.location).not.toContain("elsewhere.example");
  const response = await read(h.args(h.request(`/nushi/${answerId}.json?lang=en`), { id: String(answerId) }));
  expect((await response.json()).hidden).toBe(false);
});

it("lists pending moderation reports for operators and records hiding in the public log", async () => {
  const { loader: mod } = await import("~/routes/mod");
  const { listPublicLog } = await import("~/lib/moderation.server");
  vi.stubEnv("OPERATOR_EMAILS", "znushi_route_operator@example.com");
  const reported = await h.outcome(() => action(h.args(h.request("/nushi/action", { as: "znushi_route_reader", form: { intent: "report", answerId: String(answerId), kind: "moderation", reason: "other", note: "A source needs moderation." } }))));
  expect(reported.status).toBe(302);
  const operator = await mod(h.args(h.request("/mod", { as: "znushi_route_operator" })));
  expect(operator.nushi).toMatchObject({ count: 1, reports: [expect.objectContaining({ answerId, reason: "other" })] });
  expect(JSON.stringify(operator.nushi)).not.toContain(h.ids.znushi_route_reader);
  const report = operator.nushi!.reports[0];
  const selected = await reports(h.args(h.request(`/nushi/reports?report=${report.id}`, { as: "znushi_route_operator" })));
  expect(selected.reports.map(row => row.id)).toEqual([report.id]);
  expect((await reports(h.args(h.request(`/nushi/reports?report=${report.id}`, { as: "znushi_route_owner" })))).reports).toEqual([]);
  expect((await h.outcome(() => action(h.args(h.request("/nushi/action", { as: "znushi_route_operator", form: { intent: "moderate", reportId: String(report.id), hide: "1", note: "Hidden after source review." } }))))).status).toBe(302);
  expect((await mod(h.args(h.request("/mod", { as: "znushi_route_operator" })))).nushi).toMatchObject({ count: 0, reports: [] });
  const log = await listPublicLog(h.db);
  expect(log.entries).toContainEqual(expect.objectContaining({ action: "hide", reason: "other", nushiAnswerId: answerId }));
  expect(JSON.stringify(log)).not.toContain("Hidden after source review");
});
it.each(["", ".data"])("uses no-store only for member state or a thread with AI requests on %s reads", async (suffix) => {
  const { headers, middleware } = await import("~/routes/topic");
  const topic = await createTopic(h.db, h.ids.znushi_route_owner, { body: "A topic without AI requests.", lang: "en" });
  const pending = await createTopic(h.db, h.ids.znushi_route_owner, { body: "@nushi orchard pending", lang: "en" });
  if (!topic.ok || !pending.ok) throw new Error("Missing cache fixtures");
  const [answered] = await h.db.select().from(nushiRequests).where(eq(nushiRequests.state, "answered"));
  const cache = async (id: number | string, as?: string) => {
    const response = await middleware.at(-1)!(h.args(h.request(`/t/${id}${suffix}`, { as }), { id: String(id) }), async () => new Response("", { headers: headers() }));
    return (response as Response).headers.get("Cache-Control");
  };
  expect(headers()["Cache-Control"]).toBe("private");
  expect(await cache("999999999999999999999")).toBe("private");
  expect(await cache(topic.id)).toBe("private");
  expect(await cache(pending.id)).toBe("private, no-store");
  expect(await cache(answered.threadId)).toBe("private, no-store");
  expect(await cache(topic.id, "znushi_route_reader")).toBe("private, no-store");
  vi.stubEnv("VILLAGE_NUSHI", "");
  try {
    expect(await cache(answered.threadId)).toBe("private");
    expect(await cache(topic.id, "znushi_route_reader")).toBe("private, no-store");
  } finally { vi.stubEnv("VILLAGE_NUSHI", "1"); }
});
