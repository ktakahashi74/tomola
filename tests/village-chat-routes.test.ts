import { consentChatMembers } from "./helpers/chat-consent";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { seedRateLimit } from "./helpers/fixtures";
import { MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { chatConsents, chatMessages, chatSequences, chatTranslationReports, profiles, rateLimits, villageMembers, villages } from "~/lib/db/schema";
import { chatSourceHash, saveChatTranslation } from "~/lib/village-chat-translations.server";
import { loader as page, action } from "~/routes/village-chat";
import { loader as changes } from "~/routes/village-chat-changes";
import { loader as events } from "~/routes/village-chat-events";
import { action as readReceipt } from "~/routes/village-chat-read";
import { loader as header } from "~/routes/member-layout";
import { loader as navigation } from "~/routes/navigation-header";
import { stopVillageChat } from "~/lib/village-chat-events.server";
import { mutateChat } from "~/lib/village-chat.server";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const name of ["chatwriter", "chatmember", "chatoutsider"]) await h.signIn(name);
  const [village] = await h.db.insert(villages).values({ slug: "route-chat", kind: "open", name: "Route chat" }).returning();
  await h.db.insert(villageMembers).values(["chatwriter", "chatmember"].map(name => ({ villageId: village.id, userId: h.ids[name] })));
  await consentChatMembers(h.db);
}, 60_000);
afterAll(() => h.restore());
afterEach(() => { stopVillageChat(); vi.unstubAllEnvs(); });
const args = (as?: string, query = "") => h.args(h.request(`/v/route-chat/chat${query}`, as ? { as } : {}), { slug: "route-chat" });
const enabled = () => { vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); };

it("accepts an immutable reply parent and rejects forged parents with one public error", async () => {
  enabled();
  for (const handle of ["qry_route_writer", "qry_route_reader"]) await h.signIn(handle);
  const slug = "route-chat-replies";
  const [village] = await h.db.insert(villages).values({ slug, kind: "open" }).returning();
  await h.db.insert(villageMembers).values(["qry_route_writer", "qry_route_reader"].map(handle => ({ villageId: village.id, userId: h.ids[handle] })));
  await consentChatMembers(h.db);
  const parent = await mutateChat(h.db, h.ids.qry_route_reader, slug, "send", { body: "Route reply target" });
  const post = (replyToId: string, extra = {}) => action(h.args(h.request(`/v/${slug}/chat`, { as: "qry_route_writer", form: { intent: "send", body: "Route reply", replyToId, ...extra } }), { slug }));
  for (const replyToId of ["bad-id", "f".repeat(32)]) expect(await post(replyToId)).toMatchObject({ data: { error: "invalid_reply" }, init: { status: 400 } });
  const sent = await post(parent.id);
  expect(sent).toMatchObject({ status: 302 });
  const [reply] = await h.db.select().from(chatMessages).where(eq(chatMessages.authorId, h.ids.qry_route_writer));
  expect(reply.replyToId).toBe(parent.id);
  await post("f".repeat(32), { intent: "edit", id: reply.id, body: "Changed body" });
  expect((await h.db.select().from(chatMessages).where(eq(chatMessages.id, reply.id)))[0].replyToId).toBe(parent.id);
  await h.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, parent.id));
  expect(await post(parent.id)).toMatchObject({ data: { error: "invalid_reply" }, init: { status: 400 } });
  const unavailable = await page(h.args(h.request(`/v/${slug}/chat?at=${parent.id}`, { as: "qry_route_writer" }), { slug }));
  expect(unavailable).toMatchObject({ targetUnavailable: true, messages: [] });
  const outside = await page(h.args(h.request(`/v/${slug}/chat?at=${parent.id}`, { as: "chatoutsider" }), { slug }));
  expect(outside).toMatchObject({ data: { unavailable: true }, init: { status: 404 } });
});

it("acknowledges a translation report without exposing its case sequence number", async () => {
  enabled(); vi.stubEnv("ENABLED_LANGS", "ja,en");
  for (const handle of ["qrack_writer", "qrack_reader"]) await h.signIn(handle);
  const slug = "report-ack-chat";
  const [village] = await h.db.insert(villages).values({ slug, kind: "open" }).returning();
  await h.db.insert(villageMembers).values(["qrack_writer", "qrack_reader"].map(handle => ({ villageId: village.id, userId: h.ids[handle] })));
  await consentChatMembers(h.db);
  const sent = await mutateChat(h.db, h.ids.qrack_writer, slug, "send", { body: "原文。" });
  await saveChatTranslation(h.db, { messageId: sent.id, lang: "en", sourceHash: chatSourceHash("原文。") }, { state: "ready", text: "Wrong translation" });
  const result = await action(h.args(h.request(`/v/${slug}/chat`, { as: "qrack_reader", form: { intent: "translation-report", id: sent.id, lang: "en" } }), { slug }));
  expect(result).toMatchObject({ data: { translationReported: true } });
  expect(Object.keys((result as { data: object }).data)).toEqual(["translationReported"]);
  expect(new Headers((result as { init: { headers: HeadersInit } }).init.headers).get("X-Chat-Translation-Report")).toBeNull();
  expect(await h.db.select().from(chatTranslationReports).where(eq(chatTranslationReports.messageId, sent.id))).toHaveLength(1);
});

it("protects the read resource and returns private unread counts without changing the read policy", async () => {
  const post = (as?: string, form: Record<string, string> = { intent: "read", seq: "1" }, headers?: Record<string, string>, slug = "receipt-chat") => readReceipt(h.args(h.request(`/v/${slug}/chat/read`, { as, form, headers }), { slug }));
  expect(await h.outcome(() => post())).toMatchObject({ status: 404 });
  enabled();
  expect(await h.outcome(() => post())).toMatchObject({ status: 302, location: "/login" });
  for (const name of ["receipt_writer", "receipt_reader"]) await h.signIn(name);
  const [village] = await h.db.insert(villages).values({ slug: "receipt-chat", kind: "open" }).returning();
  await h.db.insert(villageMembers).values(["receipt_writer", "receipt_reader"].map(name => ({ villageId: village.id, userId: h.ids[name] })));
  expect(await h.outcome(() => post("receipt_reader"))).toMatchObject({ status: 404 });
  await consentChatMembers(h.db);
  await mutateChat(h.db, h.ids.receipt_writer, "receipt-chat", "send", { body: "Receipt first" });
  await mutateChat(h.db, h.ids.receipt_writer, "receipt-chat", "send", { body: "Receipt second" });
  expect(await h.outcome(() => post("receipt_reader", undefined, { origin: "https://elsewhere.example" }))).toMatchObject({ status: 403 });
  for (const form of [{ intent: "send", seq: "1" }, { intent: "read", seq: "1.5" }]) expect(await h.outcome(() => post("receipt_reader", form))).toMatchObject({ status: 400 });
  expect(await h.outcome(() => post("chatoutsider"))).toMatchObject({ status: 404 });
  await h.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, h.ids.receipt_reader));
  const response = await post("receipt_reader");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(JSON.parse(response.headers.get("X-Chat-Unread-Counts")!)).toMatchObject({ "receipt-chat": 1 });
  expect(response.headers.get("X-Unread-Notifications")).toBe("0");
  expect(await response.json()).toMatchObject({ ok: true, unreadCounts: { "receipt-chat": 1 }, notifications: 0 });
  const last = await post("receipt_reader", { intent: "read", seq: "2" });
  expect(JSON.parse(last.headers.get("X-Chat-Unread-Counts")!)).toMatchObject({ "receipt-chat": 0 });
  await seedRateLimit(h.db, `member:chat-read:${h.ids.receipt_reader}`, MEMBER_RATE_LIMITS["chat-read"]);
  const limited = await post("receipt_reader");
  expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).not.toBeNull();
});

it("validates the historical window boundary and returns its later-message status only when requested", async () => {
  enabled();
  for (const after of ["-1", "1.5", "NaN", "9007199254740992"]) expect(await h.outcome(() => changes(args("chatmember", `?since=0&after=${after}`)))).toMatchObject({ status: 400 });
  const response = await changes(args("chatmember", "?since=0&after=0"));
  expect(await response.json()).toHaveProperty("hasNewer", false);
  const ordinary = await changes(args("chatmember", "?since=0"));
  expect(await ordinary.json()).not.toHaveProperty("hasNewer");
});

it("returns ordinary disabled 404 before login, including the parent single-fetch loader", async () => {
  for (const villagesFlag of ["", "1"]) {
    vi.stubEnv("VILLAGES", villagesFlag); vi.stubEnv("VILLAGE_CHAT", "");
    const select = vi.spyOn(h.db, "select");
    for (const route of [page, changes, events]) expect(await h.outcome(() => route(args()))).toMatchObject({ status: 404 });
    for (const as of [undefined, "chatmember", "chatoutsider"]) {
      const refused = await h.outcome(() => readReceipt(h.args(h.request("/v/route-chat/chat/read", { as, form: { intent: "read", seq: "1" } }), { slug: "route-chat" })));
      expect(refused).toMatchObject({ status: 404 });
      expect(JSON.stringify(refused.value ?? null)).not.toMatch(/unreadCounts|chatMessages/);
    }
    for (const path of ["/v/route-chat/chat", "/v/route-chat/chat.data", "/v/route-chat/chat/"]) expect(await h.outcome(() => header({ request: h.request(path) }))).toMatchObject({ status: 404 });
    expect(select).not.toHaveBeenCalled(); select.mockRestore();
  }
});
it("preserves closed navigation shape and makes one unread query only while enabled", async () => {
  vi.stubEnv("VILLAGES", "1");
  const before = await (await navigation(h.args(h.request("/navigation-header", { as: "chatmember" })))).json();
  expect(before).not.toHaveProperty("chatUnreadTotal");
  expect(before.villages.every((village: object) => !("unread" in village))).toBe(true);
  enabled(); await mutateChat(h.db, h.ids.chatwriter, "route-chat", "send", { body: "An unread message" });
  const sqls: string[] = [];
  const original = h.db.select.bind(h.db);
  const spy = vi.spyOn(h.db, "select").mockImplementation(((...input: Parameters<typeof original>) => {
    const query = original(...input);
    const from = query.from.bind(query);
    query.from = ((table: never) => {
      const result = from(table);
      if (table === villageMembers) {
        const execute = result.execute.bind(result);
        result.execute = (async (...args: never[]) => { sqls.push(result.toSQL().sql); return execute(...args); }) as typeof result.execute;
      }
      return result;
    }) as typeof query.from;
    return query;
  }) as typeof h.db.select);
  const after = await (await navigation(h.args(h.request("/navigation-header", { as: "chatmember" })))).json(); spy.mockRestore();
  expect(after.chatUnreadTotal).toBe(1);
  // The bounded aggregate is a single statement over all the requesting member's villages.
  expect(sqls.filter(s => s.includes("chat_messages"))).toHaveLength(1);
  vi.stubEnv("VILLAGE_CHAT", ""); const closed = await (await navigation(h.args(h.request("/navigation-header", { as: "chatmember" })))).json();
  expect(closed).toEqual(before);
});
it("uses resource 401/404 and page login/redirect without granting operator access", async () => {
  enabled();
  for (const route of [changes, events]) {
    expect(await h.outcome(() => route(args()))).toMatchObject({ status: 401 });
    expect(await h.outcome(() => route(args("chatoutsider")))).toMatchObject({ status: 404 });
    expect(await h.outcome(() => route(h.args(h.request("/v/missing/chat", { as: "chatoutsider" }), { slug: "missing" })))).toMatchObject({ status: 404 });
  }
  expect(await h.outcome(() => page(args()))).toMatchObject({ status: 302 });
  expect(await h.outcome(() => page(args("chatoutsider")))).toMatchObject({ status: 302, location: "/v/route-chat" });
  vi.stubEnv("OPERATOR_EMAILS", "chatoutsider@example.com"); expect(await h.outcome(() => changes(args("chatoutsider")))).toMatchObject({ status: 404 });
});
it("resource reads do not consume the shared browser read budget, and connections are private", async () => {
  enabled();
  const before = (await h.db.select().from(rateLimits)).filter(row => row.key.startsWith("read:"));
  const response = await changes(args("chatmember", "?since=0")); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const stream = await events(args("chatmember")); expect(stream.headers.get("Cache-Control")).toBe("private, no-store, no-transform"); await stream.body!.cancel();
  const rows = await h.db.select().from(rateLimits);
  expect(rows.filter(row => row.key === `member:chat-changes:${h.ids.chatmember}`)).toHaveLength(1); expect(rows.filter(row => row.key === `member:chat-events:${h.ids.chatmember}`)).toHaveLength(1);
  expect(rows.filter(row => row.key.startsWith("read:"))).toEqual(before);
});

it("counts nonmember and nonexistent-village resource requests before the membership query", async () => {
  enabled();
  for (const route of [changes, events]) {
    expect(await h.outcome(() => route(args("chatoutsider")))).toMatchObject({ status: 404 });
    expect(await h.outcome(() => route(h.args(h.request("/v/missing/chat", { as: "chatoutsider" }), { slug: "missing" })))).toMatchObject({ status: 404 });
  }
  const rows = await h.db.select().from(rateLimits);
  for (const kind of ["chat-changes", "chat-events"]) expect(rows.find(row => row.key === `member:${kind}:${h.ids.chatoutsider}`)?.count).toBeGreaterThanOrEqual(2);
});
it("protects actions with origin and writer gates and permits suspended own deletion", async () => {
  enabled();
  const post = (name: string, form: Record<string, string>, headers?: Record<string, string>) => action(h.args(h.request("/v/route-chat/chat", { as: name, form, headers }), { slug: "route-chat" }));
  expect(await h.outcome(() => post("chatwriter", { intent: "send", body: "No" }, { origin: "https://elsewhere.example" }))).toMatchObject({ status: 403 });
  expect(await h.outcome(() => post("chatoutsider", { intent: "send", body: "Denied" }))).toMatchObject({ status: 404 });
  const own = await mutateChat(h.db, h.ids.chatmember, "route-chat", "send", { body: "May delete" });
  await h.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, h.ids.chatmember));
  expect(await h.outcome(() => post("chatmember", { intent: "send", body: "No" }))).toMatchObject({ status: 302, location: "/suspended" });
  expect(await h.outcome(() => post("chatmember", { intent: "delete", id: own.id }))).toMatchObject({ status: 302, location: "/v/route-chat/chat" });
  expect((await h.db.select().from(chatMessages).where(eq(chatMessages.id, own.id)))[0].body).toBe("");
});

it("redirects single-fetch submissions to the document URL and enforces sending limits", async () => {
  enabled();
  const outcome = await h.outcome(() => action(h.args(h.request("/v/route-chat/chat.data?_routes=routes%2Fvillage-chat", { as: "chatwriter", form: { intent: "send", body: "Canonical return" } }), { slug: "route-chat" })));
  expect(outcome).toMatchObject({ status: 302, location: expect.stringMatching(/^\/v\/route-chat\/chat\?latest=1#chat-[a-f0-9]{32}$/) });
  await h.db.delete(rateLimits).where(eq(rateLimits.key, `member:chat-send-minute:${h.ids.chatwriter}`));
  await h.db.delete(rateLimits).where(eq(rateLimits.key, `member:chat-send-hour:${h.ids.chatwriter}`));
  await seedRateLimit(h.db, `member:chat-send-minute:${h.ids.chatwriter}`, { ...MEMBER_RATE_LIMITS["chat-send-minute"], limit: MEMBER_RATE_LIMITS["chat-send-minute"].limit - 1 });
  expect(await h.outcome(() => action(h.args(h.request("/v/route-chat/chat", { as: "chatwriter", form: { intent: "send", body: "Last minute slot" } }), { slug: "route-chat" })))).toMatchObject({ status: 302 });
  expect(await h.outcome(() => action(h.args(h.request("/v/route-chat/chat", { as: "chatwriter", form: { intent: "send", body: "Over minute cap" } }), { slug: "route-chat" })))).toMatchObject({ status: 429 });
});

it("returns a consent-only page, denies resources and mutations, and accepts consent with member and origin gates", async () => {
  enabled();
  for (const handle of ["ccroute_owner", "ccroute_member"]) await h.signIn(handle);
  const slug = "route-consent";
  const [village] = await h.db.insert(villages).values({ slug, kind: "open" }).returning();
  await h.db.insert(villageMembers).values(["ccroute_owner", "ccroute_member"].map(handle => ({ villageId: village.id, userId: h.ids[handle], role: handle === "ccroute_owner" ? "owner" : "member" })));
  const messages = await h.db.insert(chatMessages).values(["ccroute_owner", "ccroute_member"].map((handle, i) => ({ villageId: village.id, authorId: h.ids[handle], body: "Unreadable until consent", lang: "en", createdSeq: i + 1, changedSeq: i + 1 }))).returning();
  const read = (as?: string, query = "") => h.args(h.request(`/v/${slug}/chat${query}`, { as }), { slug });
  const post = (as?: string, form = { intent: "consent", version: String(CHAT_CONSENT_VERSION) } as Record<string, string>, headers?: Record<string, string>) => action(h.args(h.request(`/v/${slug}/chat`, { as, form, headers }), { slug }));
  for (const handle of ["ccroute_owner", "ccroute_member"]) {
    expect(await page(read(handle))).toMatchObject({ consentRequired: true });
    expect(await page(read(handle))).not.toHaveProperty("messages");
    for (const resource of [changes, events]) expect(await h.outcome(() => resource(read(handle, "?since=0")))).toMatchObject({ status: 404 });
    for (const intent of ["send", "edit", "delete", "read"]) expect(await h.outcome(() => post(handle, { intent, body: "Blocked", id: messages.find(row => row.authorId === h.ids[handle])!.id, seq: "2" }))).toMatchObject({ status: 404 });
  }
  expect(await h.outcome(() => post())).toMatchObject({ status: 302, location: "/login" });
  expect(await h.outcome(() => post("chatoutsider"))).toMatchObject({ status: 404 });
  expect(await h.outcome(() => post("ccroute_member", { intent: "consent" }, { origin: "https://elsewhere.example" }))).toMatchObject({ status: 403 });
  const invalidConsents: Record<string, string>[] = [{ intent: "consent" }, { intent: "consent", version: "0" }];
  for (const form of invalidConsents) expect(await h.outcome(() => post("ccroute_member", form))).toMatchObject({ status: 400 });
  expect(await h.db.select().from(chatConsents).where(eq(chatConsents.villageId, village.id))).toEqual([]);
  await h.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, h.ids.ccroute_member));
  // Consent permits reading even when writing is suspended.
  expect(await h.outcome(() => post("ccroute_member"))).toMatchObject({ status: 302, location: `/v/${slug}/chat` });
  expect(await page(read("ccroute_member"))).toMatchObject({ consentRequired: false, messages: expect.any(Array) });
  expect((await changes(read("ccroute_member", "?since=0"))).status).toBe(200);
  const stream = await events(read("ccroute_member")); expect(stream.status).toBe(200); await stream.body!.cancel();
  expect(await page(read("ccroute_owner"))).toHaveProperty("consentRequired", true);
  vi.stubEnv("VILLAGE_CHAT", "");
  expect(await h.outcome(() => post("ccroute_owner"))).toMatchObject({ status: 404 });
  expect(await h.db.select().from(chatConsents).where(eq(chatConsents.villageId, village.id))).toHaveLength(1);
});

it.each([1, 2])("blocks version-%i readers and writers until current consent updates the existing record", async previousVersion => {
  enabled();
  const handle = `ccroute_renew${previousVersion}`, slug = `route-renew-${previousVersion}`;
  await h.signIn(handle);
  const [village] = await h.db.insert(villages).values({ slug, kind: "open" }).returning();
  await h.db.insert(villageMembers).values({ villageId: village.id, userId: h.ids[handle] });
  const oldTime = new Date("2026-01-01T00:00:00Z");
  const [message] = await h.db.insert(chatMessages).values({ villageId: village.id, authorId: h.ids.chatwriter, lang: "en", body: "History after renewed consent", createdSeq: 1, changedSeq: 1 }).returning();
  await h.db.insert(chatSequences).values({ villageId: village.id, seq: 1 });
  const read = (query = "") => h.args(h.request(`/v/${slug}/chat${query}`, { as: handle }), { slug });
  const post = (form: Record<string, string>) => action(h.args(h.request(`/v/${slug}/chat`, { as: handle, form }), { slug }));
  expect(await h.outcome(() => post({ intent: "flag", id: message.id, reason: "spam" }))).toMatchObject({ status: 404 });
  await h.db.insert(chatConsents).values({ villageId: village.id, userId: h.ids[handle], version: previousVersion, consentedAt: oldTime });
  expect(await page(read())).toMatchObject({ consentRequired: true, consentVersion: CHAT_CONSENT_VERSION, previousConsentVersion: previousVersion });
  expect(await page(read())).not.toHaveProperty("messages");
  expect(await h.outcome(() => post({ intent: "flag", id: message.id, reason: "spam" }))).toMatchObject({ status: 404 });
  for (const resource of [changes, events]) expect(await h.outcome(() => resource(read("?since=0")))).toMatchObject({ status: 404 });
  for (const intent of ["send", "edit", "delete", "read"]) expect(await h.outcome(() => post({ intent, body: "Denied", id: message.id, seq: "1" }))).toMatchObject({ status: 404 });
  expect(await h.outcome(() => readReceipt(h.args(h.request(`/v/${slug}/chat/read`, { as: handle, form: { intent: "read", seq: "1" } }), { slug })))).toMatchObject({ status: 404 });
  expect(await h.outcome(() => post({ intent: "consent", version: String(previousVersion) }))).toMatchObject({ status: 400 });
  expect(await h.db.select().from(chatConsents).where(eq(chatConsents.villageId, village.id))).toMatchObject([{ version: previousVersion, consentedAt: oldTime }]);
  expect(await h.outcome(() => post({ intent: "consent", version: String(CHAT_CONSENT_VERSION) }))).toMatchObject({ status: 302 });
  const records = await h.db.select().from(chatConsents).where(eq(chatConsents.villageId, village.id));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ version: CHAT_CONSENT_VERSION, userId: h.ids[handle] });
  expect(records[0].consentedAt.getTime()).toBeGreaterThan(oldTime.getTime());
  expect(await page(read())).toMatchObject({ consentRequired: false, messages: [{ id: message.id }] });
  expect((await changes(read("?since=0"))).status).toBe(200);
  expect(await h.outcome(() => post({ intent: "flag", id: message.id, reason: "spam" }))).toMatchObject({ status: 302 });
  expect(await h.outcome(() => post({ intent: "send", body: "Writing after renewed consent" }))).toMatchObject({ status: 302 });
});
