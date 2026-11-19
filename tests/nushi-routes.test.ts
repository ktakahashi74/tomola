import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { expectModerationReauthentication, withStaleSession } from "./helpers/reauth";
import { createTopic } from "~/lib/entries.server";
import { moderationActions, nushiAnswers, nushiReports, nushiRequests, rateLimits } from "~/lib/db/schema";
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
it("explains unavailable historical evidence without saving an inaccurate report", async () => {
  const { entries, translations } = await import("~/lib/db/schema");
  const { m } = await import("~/paraglide/messages.js");
  const source = await createTopic(h.db, h.ids.znushi_route_owner, { body: "Orchard historical report source.", lang: "ja" });
  if (!source.ok) throw new Error(source.error);
  const [entry] = await h.db.select().from(entries).where(eq(entries.id, source.id));
  await h.db.insert(translations).values({ entryId: source.id, lang: "en", text: "A supplied orchard translation.", sourceHash: entry.sourceHash, kind: "primary", field: "body", flags: [] });
  const topic = await createTopic(h.db, h.ids.znushi_route_owner, { body: "@nushi orchard historical report", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  const [request] = await h.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, topic.id));
  await processNushiRequest(h.db, request.id);
  const [answer] = await h.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, request.id));
  expect(answer.scope.materialIndex.some(item => item.translation)).toBe(true);
  await h.db.update(translations).set({ text: "A corrected translation." }).where(eq(translations.entryId, source.id));
  const before = await h.db.select().from(nushiReports);
  const outcome = await h.outcome(() => action(h.args(h.request("/nushi/action", { as: "znushi_route_reader", form: { intent: "report", answerId: String(answer.id), kind: "error", reason: "wrong_post", consent: "1" } }))));
  expect(outcome.status).toBe(302);
  expect(outcome.location).toBe(`/nushi/${answer.id}?report=unavailable`);
  expect(await h.db.select().from(nushiReports)).toEqual(before);
  const { loader: readPage } = await import("~/routes/nushi-answer");
  const page = await readPage(h.args(h.request(outcome.location!, { as: "znushi_route_reader" }), { id: String(answer.id) }));
  expect(page.html).toContain(m.nushi_report_unavailable());
  expect(page.html).toContain("data-nushi-report-unavailable");
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
it("lets readers clear hide preferences on topics without answers while Nushi is enabled", async () => {
  const { loader } = await import("~/routes/topic");
  const topic = await createTopic(h.db, h.ids.znushi_route_owner, { body: "A topic with no Nushi answers.", lang: "en" });
  if (!topic.ok) throw new Error("Missing topic fixture");
  const path = `/t/${topic.id}?lang=en`;
  const params = { id: String(topic.id) };
  const as = "znushi_route_reader";
  expect((await h.outcome(() => action(h.args(h.request("/nushi/action", { as, form: { intent: "preferences", hide: "1" } }))))).status).toBe(302);
  const controls = async (options: Parameters<typeof h.request>[1]) => (await loader(h.args(h.request(path, options), params))).nushi.controls;
  const visitor = { headers: { cookie: "nushi_hidden=1" } };
  for (const [options, intent] of [[visitor, "visitor-hide"], [{ as }, "preferences"]] as const) {
    const hidden = await controls(options);
    expect(hidden).toContain(`value="${intent}"`);
    expect(hidden).toContain('checked=""');
  }
  expect(await controls({ headers: { cookie: "nushi_hidden=0" } })).toBe("");
  vi.stubEnv("VILLAGE_NUSHI", "");
  try {
    expect(await controls(visitor)).toBe("");
    expect(await controls({ as })).toBe("");
  } finally { vi.stubEnv("VILLAGE_NUSHI", "1"); }
});

it("requires a recent sign-in before resolving a Nushi report", async () => {
  vi.stubEnv("OPERATOR_EMAILS", "znushi_route_operator@example.com");
  const created = await createTopic(h.db, h.ids.znushi_route_owner, { body: "@nushi orchard re-verification", lang: "en" });
  if (!created.ok) throw new Error(created.error);
  const [request] = await h.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, created.id));
  await processNushiRequest(h.db, request.id);
  const answers = () => h.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, request.id));
  const [answer] = await answers();
  const submit = (as: string, form: Record<string, string>) => h.outcome(() => action(h.args(h.request("/nushi/action", { as, form }))));
  expect((await submit("znushi_route_reader", { intent: "report", answerId: String(answer.id), kind: "moderation", reason: "other", note: "Review this answer" })).status).toBe(302);
  const reports = () => h.db.select().from(nushiReports).where(eq(nushiReports.answerId, answer.id));
  const [report] = await reports();
  const rates = () => h.db.select().from(rateLimits).where(eq(rateLimits.key, `member:edit:${h.ids.znushi_route_operator}`));
  const log = () => h.db.select().from(moderationActions).where(eq(moderationActions.targetNushiAnswerId, answer.id));
  const rateBefore = await rates();
  const form = { intent: "moderate", reportId: String(report.id), hide: "1", note: "Hide after review" };
  await withStaleSession(h, "znushi_route_operator", async () => {
    expectModerationReauthentication(await submit("znushi_route_operator", form), "/nushi/reports");
    expect(await answers()).toEqual([answer]);
    expect(await reports()).toEqual([report]);
    expect(await log()).toEqual([]);
    expect(await rates()).toEqual(rateBefore);
  });
  expect((await submit("znushi_route_operator", form)).status).toBe(302);
});

it.each(["", ".data"])("keeps member state and AI requests fresh and varies ordinary topic reads by cookie on %s", async (suffix) => {
  const { headers, middleware } = await import("~/routes/topic");
  const topic = await createTopic(h.db, h.ids.znushi_route_owner, { body: "A topic without AI requests.", lang: "en" });
  const pending = await createTopic(h.db, h.ids.znushi_route_owner, { body: "@nushi orchard pending", lang: "en" });
  if (!topic.ok || !pending.ok) throw new Error("Missing cache fixtures");
  const [answered] = await h.db.select().from(nushiRequests).where(eq(nushiRequests.state, "answered"));
  const responseHeaders = async (id: number | string, as?: string) => {
    const response = await middleware.at(-1)!(h.args(h.request(`/t/${id}${suffix}`, { as }), { id: String(id) }), async () => new Response("", { headers: headers() }));
    return (response as Response).headers;
  };
  const cache = async (id: number | string, as?: string) => (await responseHeaders(id, as)).get("Cache-Control");
  expect(headers()["Cache-Control"]).toBe("private");
  expect(await cache("999999999999999999999")).toBe("private");
  expect(await cache(topic.id)).toBe("private");
  expect((await responseHeaders(topic.id)).get("Vary")).toContain("Cookie");
  expect(await cache(pending.id)).toBe("private, no-store");
  expect(await cache(answered.threadId)).toBe("private, no-store");
  expect(await cache(topic.id, "znushi_route_reader")).toBe("private, no-store");
  vi.stubEnv("VILLAGE_NUSHI", "");
  try {
    expect(await cache(answered.threadId)).toBe("private");
    expect(await cache(topic.id, "znushi_route_reader")).toBe("private, no-store");
  } finally { vi.stubEnv("VILLAGE_NUSHI", "1"); }
});

it("allows only the caller to refresh through a same-origin form and preserves warnings on public output", async () => {
  const { editEntry } = await import("~/lib/entries.server");
  const { entries } = await import("~/lib/db/schema");
  const { loader: page } = await import("~/routes/nushi-answer");
  const { m } = await import("~/paraglide/messages.js");
  const topic = await createTopic(h.db, h.ids.znushi_route_owner, { body: "@nushi orchard fresh", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  const [request] = await h.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, topic.id));
  await processNushiRequest(h.db, request.id);
  const [answer] = await h.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, request.id));
  const [entry] = await h.db.select().from(entries).where(eq(entries.id, topic.id));
  expect(await editEntry(h.db, entry.authorId, entry.id, { body: entry.body + " Revised wording.", lang: "en" }, { now: new Date(entry.createdAt.getTime() + 3_600_000) })).toMatchObject({ ok: true });
  const response = await read(h.args(h.request(`/nushi/${answer.id}.json?lang=en`), { id: String(answer.id) }));
  expect(await response.json()).toMatchObject({ hidden: false, sourcesChanged: true });
  const markdown = await read(h.args(h.request(`/nushi/${answer.id}.md?lang=en`), { id: String(answer.id) }));
  expect(await markdown.text()).toContain(m.nushi_sources_edited());
  for (const as of [undefined, "znushi_route_reader", "znushi_route_owner"]) {
    const view = await page(h.args(h.request(`/nushi/${answer.id}?lang=en`, { as }), { id: String(answer.id) }));
    expect(view.html.includes("data-nushi-refresh")).toBe(as === "znushi_route_owner");
  }
  const form = { intent: "refresh", answerId: String(answer.id) };
  const submit = (as?: string, headers?: Record<string, string>) => h.outcome(() => action(h.args(h.request("/nushi/action", { as, form, headers }))));
  expect((await submit()).status).toBe(302);
  expect((await submit("znushi_route_reader")).status).toBe(400);
  expect((await submit("znushi_route_owner", { origin: "https://elsewhere.example" })).status).toBe(403);
  expect(await h.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, topic.id))).toHaveLength(1);
  expect((await submit("znushi_route_owner")).status).toBe(302);
  expect(await h.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, topic.id))).toHaveLength(2);
});

it("excludes unavailable source text from JSON and Markdown while retaining a marker", async () => {
  const { entries } = await import("~/lib/db/schema");
  const topic = await createTopic(h.db, h.ids.znushi_route_owner, { body: "@nushi orchard unavailable", lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  const [request] = await h.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, topic.id));
  await processNushiRequest(h.db, request.id);
  const [answer] = await h.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, request.id));
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topic.id));
  const json = await read(h.args(h.request(`/nushi/${answer.id}.json?lang=en`), { id: String(answer.id) }));
  expect(await json.json()).toMatchObject({ hidden: true, reason: "source_changed" });
  const markdown = await read(h.args(h.request(`/nushi/${answer.id}.md?lang=en`), { id: String(answer.id) }));
  expect(await markdown.text()).not.toContain(answer.answer.readings[0].text);
});
