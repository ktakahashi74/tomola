import { PG_MODE } from "./helpers/pg-test";
import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { consentChatMembers } from "./helpers/chat-consent";
import { chatConsents, chatMessages, chatMessageTranslations, chatNushiRequests, chatNushiSources, chatNushiReservations, chatReads, entries, jobs, notifications, profiles, villageMembers, villages } from "~/lib/db/schema";
import { chatChanges, chatPage, chatUnreadCounts, markChatRead, mutateChat } from "~/lib/village-chat.server";
import { processChatNushiRequest, expireChatNushiRequests } from "~/lib/chat-nushi.server";
import { createTopic } from "~/lib/entries.server";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
import { findChatMessages } from "~/lib/village-chat-search.server";
import { chatTranslationSource, chatSourceHash } from "~/lib/village-chat-translations.server";
import { countUnreadNotifications, listNotifications } from "~/lib/notifications.server";
import { createChatReport, readChatEvidence } from "~/lib/village-chat-reports.server";
import { readNushiAnswer, resolveNushiCompleter, threadNushi } from "~/lib/nushi.server";
import { aiUsePage } from "~/lib/ai-use-page.server";
import { m } from "~/paraglide/messages.js";
import { CHAT_CASE_CONTEXT_COUNT } from "~/lib/chat-access";
import { CHAT_NUSHI_PROMPT_VERSION } from "~/lib/chat-nushi-config.server";
import { assertNushiConfig, chatNushiLimits, nushiLimits } from "~/lib/nushi-config.server";
import { createChatTranslationHandlers } from "~/lib/jobs/chat-translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("VILLAGE_CHAT_NUSHI", "1"); vi.stubEnv("VILLAGE_NUSHI", "0"); vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("TRANSLATION_PRIMARY", "fake");
  const db = await createTestDb();
  for (const id of ["zcn_owner", "zcn_caller", "zcn_reader", "zcn_outside", "zcn_mod"]) await addMember(db, id, id, { homeArea: "en", readLangs: ["en"] });
  const [village] = await db.insert(villages).values({ kind: "open", slug: "chat-nushi" }).returning();
  await db.insert(villageMembers).values(["zcn_owner", "zcn_caller", "zcn_reader"].map(userId => ({ villageId: village.id, userId })));
  await consentChatMembers(db);
  const source = await createTopic(db, "zcn_owner", { title: "Orchard plan", body: "The orchard needs public review. Some growers disagree about timing.", lang: "en", village: village.slug });
  if (!source.ok) throw new Error(source.error);
  const call = async (body = "@nushi orchard", extra: { replyToId?: string; suppressNushi?: boolean } = {}, callerId = "zcn_caller") => {
    const sent = await mutateChat(db, callerId, village.slug!, "send", { body, ...extra });
    const [request] = await db.select().from(chatNushiRequests).where(eq(chatNushiRequests.messageId, sent.id));
    return { sent, request };
  };
  return { db, village, source: source.id, call };
}
it("publishes a private source guide without an AI member or human unread/search effects", async () => {
  const w = await world(), c = await w.call();
  await markChatRead(w.db, "zcn_reader", w.village.slug!, c.sent.seq);
  await processChatNushiRequest(w.db, c.request.id);
  const [request] = await w.db.select().from(chatNushiRequests);
  expect(request.state).toBe("answered");
  expect(request).not.toHaveProperty("sourceHash");
  const page = (await chatPage(w.db, "zcn_reader", w.village.slug!))!;
  if (page.consentRequired) throw new Error("Consent missing");
  const answer = page.messages.at(-1)!;
  expect(answer).toMatchObject({ nushi: { caller: "zcn_caller", edited: false }, own: false, reply: { id: c.sent.id }, author: "nushi" });
  expect(JSON.stringify(answer)).toContain("zcn_owner");
  expect((await chatUnreadCounts(w.db, "zcn_reader")).get(w.village.slug!)).toBe(0);
  await markChatRead(w.db, "zcn_reader", w.village.slug!, page.seq);
  expect((await w.db.select().from(chatReads).where(eq(chatReads.userId, "zcn_reader")))[0].seq).toBe(c.sent.seq);
  expect((await findChatMessages(w.db, w.village.id, "orchard", "en")).hits.map(hit => hit.id)).toEqual([c.sent.id]);
  expect(await chatPage(w.db, "zcn_outside", w.village.slug!)).toBeNull();
  expect((await threadNushi(w.db, w.source, [w.source], "en")).answers).toEqual([]);
  expect(await readNushiAnswer(w.db, 1)).toBeNull();
  const notices = await w.db.select().from(notifications);
  expect(notices.filter(n => n.userId === "zcn_caller")).toMatchObject([{ kind: "chat_nushi_result" }]);
  expect(notices.filter(n => n.kind === "chat_reply")).toHaveLength(0);
  expect(notices.filter(n => n.kind === "chat_nushi_cited")).toMatchObject([{ userId: "zcn_owner" }]);
  const reply = await mutateChat(w.db, "zcn_reader", w.village.slug!, "send", { body: "Thank you", replyToId: answer.id });
  expect((await w.db.select().from(notifications)).filter(n => n.chatMessageId === reply.id)).toEqual([]);
});

it("ignores person and clarification flags on a sourced chat answer", async () => {
  const w = await world(), c = await w.call(), fake = resolveNushiCompleter();
  await processChatNushiRequest(w.db, c.request.id, { completer: { ...fake, async complete(req) {
    const result = await fake.complete(req);
    return { ...result, text: JSON.stringify({ ...JSON.parse(result.text), askPerson: true, clarificationNeeded: true }) };
  } } });
  const [answer] = await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"));
  expect(answer.nushiShape).toMatchObject({ status: "answered" });
  expect(answer.nushiShape).not.toHaveProperty("askPerson");
  expect(answer.body).not.toContain(m.nushi_ask_person());
  expect(answer.body).not.toContain(m.chat_nushi_clarify());
});
it("sends only the projected calling message, including for a follow-up with a reply target", async () => {
  const w = await world();
  const parent = await mutateChat(w.db, "zcn_reader", w.village.slug!, "send", { body: "PRIVATE_REPLY_TARGET_NEVER_SEND" });
  const c = await w.call('@nushi orchard <!-- HIDDEN_INSTRUCTION -->', { replyToId: parent.id });
  let captured = "";
  await processChatNushiRequest(w.db, c.request.id, { completer: { engine: "fake", model: "fake", async complete(req) { captured = req.user; return { text: JSON.stringify({ status: "not_confirmed", readings: [] }), inputTokens: 1, outputTokens: 1 }; } } });
  const input = JSON.parse(captured);
  expect(input.context).toEqual({ callingMessage: "@nushi orchard" });
  expect(captured).not.toContain("PRIVATE_REPLY_TARGET_NEVER_SEND");
  expect(captured).not.toContain("HIDDEN_INSTRUCTION");
  const privateRecords = JSON.stringify([await w.db.select().from(chatNushiRequests), await w.db.select().from(chatNushiSources), await w.db.select().from(chatNushiReservations), await w.db.select().from(jobs)]);
  expect(privateRecords).not.toContain("@nushi orchard");
  expect(privateRecords).not.toContain("PRIVATE_REPLY_TARGET_NEVER_SEND");
});
it.each(["off", "village-off", "language", "suppressed", "quote", "code", "edited"])("does not call Nushi for %s", async mode => {
  const w = await world();
  if (mode === "off") vi.stubEnv("VILLAGE_CHAT_NUSHI", "0");
  if (mode === "village-off") await w.db.update(villages).set({ nushiEnabled: false });
  if (mode === "language") {
    await w.db.update(villages).set({ language: "ja", system: true, slug: "ja" }).where(eq(villages.id, w.village.id));
    w.village.slug = "ja";
  }
  const body = mode === "quote" ? "> @nushi orchard" : mode === "code" ? "`@nushi orchard`" : mode === "edited" ? "orchard" : "@nushi orchard";
  const c = await w.call(body, { suppressNushi: mode === "suppressed" });
  if (mode === "edited") await mutateChat(w.db, "zcn_caller", w.village.slug!, "edit", { id: c.sent.id, body: "@nushi orchard" });
  expect(await w.db.select().from(chatNushiRequests)).toEqual([]);
});
it.each(["edit", "delete", "leave", "consent", "suspend", "village-off", "switch-off"])("cancels before publication after %s", async mode => {
  const w = await world(), c = await w.call();
  const mutate = async () => {
    if (mode === "edit") await mutateChat(w.db, "zcn_caller", w.village.slug!, "edit", { id: c.sent.id, body: "Changed question" });
    if (mode === "delete") await mutateChat(w.db, "zcn_caller", w.village.slug!, "delete", { id: c.sent.id });
    if (mode === "leave") await w.db.delete(villageMembers).where(eq(villageMembers.userId, "zcn_caller"));
    if (mode === "consent") await w.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION - 1 }).where(eq(chatConsents.userId, "zcn_caller"));
    if (mode === "suspend") await w.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 60000) }).where(eq(profiles.userId, "zcn_caller"));
    if (mode === "village-off") await w.db.update(villages).set({ nushiEnabled: false });
    if (mode === "switch-off") vi.stubEnv("VILLAGE_CHAT_NUSHI", "0");
  };
  await processChatNushiRequest(w.db, c.request.id, { completer: { engine: "fake", model: "fake", async complete() { await mutate(); return { text: JSON.stringify({ status: "not_confirmed", readings: [] }), inputTokens: 1, outputTokens: 1 }; } } });
  expect((await w.db.select().from(chatNushiRequests))[0].state).toBe("cancelled");
  expect(await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"))).toEqual([]);
});
it("redacts the answer, its translation and reply excerpt when a source changes", async () => {
  const w = await world(), c = await w.call(); await processChatNushiRequest(w.db, c.request.id);
  const [answer] = await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"));
  const reply = await mutateChat(w.db, "zcn_reader", w.village.slug!, "send", { body: "A human follow-up", replyToId: answer.id });
  await w.db.insert(chatMessageTranslations).values({ messageId: answer.id, lang: "ja", sourceHash: chatSourceHash(answer.body), state: "ready", text: "OLD_QUOTE" });
  await w.db.update(entries).set({ body: "Changed source" }).where(eq(entries.id, w.source));
  expect(await w.db.select().from(chatMessageTranslations).where(eq(chatMessageTranslations.messageId, answer.id))).toEqual([]);
  const page = (await chatPage(w.db, "zcn_reader", w.village.slug!))!;
  expect(JSON.stringify(page)).not.toContain("OLD_QUOTE");
  if (page.consentRequired) throw new Error("Consent missing");
  expect(page.messages.find(m => m.id === answer.id)).toMatchObject({ hidden: true, parts: [] });
  expect(page.messages.find(m => m.id === reply.id)).toMatchObject({ reply: { unavailable: true } });
  expect((await listNotifications(w.db, "zcn_caller")).items).toEqual([]);
});
it("annotates a later calling edit and withdraws on calling deletion", async () => {
  const w = await world(), c = await w.call(); await processChatNushiRequest(w.db, c.request.id);
  await mutateChat(w.db, "zcn_caller", w.village.slug!, "edit", { id: c.sent.id, body: "Edited call" });
  let page = (await chatPage(w.db, "zcn_reader", w.village.slug!))!;
  if (page.consentRequired) throw new Error("Consent missing");
  expect(page.messages.at(-1)).toMatchObject({ nushi: { edited: true }, hidden: false });
  await mutateChat(w.db, "zcn_caller", w.village.slug!, "delete", { id: c.sent.id });
  page = (await chatPage(w.db, "zcn_reader", w.village.slug!))!;
  if (page.consentRequired) throw new Error("Consent missing");
  expect(page.messages.at(-1)).toMatchObject({ hidden: true });
});
it("defaults to two chat answers per minute across callers and publishes retries once", async () => {
  const w = await world();
  const start = Date.now(); let now = new Date(start); const clock = () => now;
  for (let i = 0; i < 2; i++) { const c = await w.call(); await processChatNushiRequest(w.db, c.request.id, { clock }); await processChatNushiRequest(w.db, c.request.id, { clock }); }
  expect(await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"))).toHaveLength(2);
  now = new Date(start + 59_999);
  const blocked = await w.call("@nushi orchard", {}, "zcn_reader");
  const complete = vi.fn();
  await processChatNushiRequest(w.db, blocked.request.id, { clock, completer: { engine: "fake", model: "fake", complete } });
  await processChatNushiRequest(w.db, blocked.request.id, { clock });
  expect(complete).not.toHaveBeenCalled();
  expect((await w.db.select().from(chatNushiRequests).where(eq(chatNushiRequests.id, blocked.request.id)))[0]).toMatchObject({ state: "failed", failure: "interval", attempts: 0 });
  expect(await w.db.select().from(chatNushiReservations).where(eq(chatNushiReservations.requestId, blocked.request.id))).toEqual([]);
  const own = (await chatPage(w.db, "zcn_reader", w.village.slug!))!;
  const other = (await chatPage(w.db, "zcn_caller", w.village.slug!))!;
  if (own.consentRequired || other.consentRequired) throw new Error("Missing consent");
  expect(own.messages.find(message => message.id === blocked.sent.id)).toMatchObject({ nushiCall: { state: "failed", failure: "interval" } });
  expect(other.messages.find(message => message.id === blocked.sent.id)).not.toHaveProperty("nushiCall");
  expect((await listNotifications(w.db, "zcn_reader")).items).toMatchObject([{ kind: "chat_nushi_result", chat: { id: blocked.sent.id } }]);
  now = new Date(start + 60_001);
  const next = await w.call(); await processChatNushiRequest(w.db, next.request.id, { clock });
  expect((await w.db.select().from(chatNushiRequests).where(eq(chatNushiRequests.id, next.request.id)))[0].state).toBe("answered");
  expect(await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"))).toHaveLength(3);
  expect((await w.db.select().from(notifications)).filter(r => r.kind === "chat_nushi_result")).toHaveLength(4);
});
it("uses the configured chat interval and allowance without changing posting allowances", async () => {
  const w = await world();
  const env = { ...process.env, VILLAGE_CHAT_NUSHI_INTERVAL_SECONDS: "120", VILLAGE_CHAT_NUSHI_INTERVAL_LIMIT: "3" };
  const start = Date.now(); let now = new Date(start); const clock = () => now;
  for (let i = 0; i < 3; i++) { const c = await w.call(); await processChatNushiRequest(w.db, c.request.id, { env, clock }); }
  expect(await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"))).toHaveLength(3);
  for (const elapsed of [0, 60_001]) {
    now = new Date(start + elapsed);
    const c = await w.call(); await processChatNushiRequest(w.db, c.request.id, { env, clock });
    expect((await w.db.select().from(chatNushiRequests).where(eq(chatNushiRequests.id, c.request.id)))[0]).toMatchObject({ state: "failed", failure: "interval" });
  }
  now = new Date(start + 120_001);
  const c = await w.call(); await processChatNushiRequest(w.db, c.request.id, { env, clock });
  expect((await w.db.select().from(chatNushiRequests).where(eq(chatNushiRequests.id, c.request.id)))[0].state).toBe("answered");
  expect(nushiLimits(env)).toEqual(nushiLimits(process.env));
});
it.each([true, false])("counts processing requests only while their lease is active: %s", async active => {
  const w = await world(), first = await w.call(), now = new Date();
  const env = { ...process.env, VILLAGE_CHAT_NUSHI_INTERVAL_LIMIT: "1" };
  await w.db.update(chatNushiRequests).set({ state: "processing", leaseUntil: new Date(now.getTime() + (active ? 300_000 : -1)) }).where(eq(chatNushiRequests.id, first.request.id));
  const second = await w.call(); await processChatNushiRequest(w.db, second.request.id, { env, clock: () => now });
  expect((await w.db.select().from(chatNushiRequests).where(eq(chatNushiRequests.id, second.request.id)))[0]).toMatchObject(active ? { state: "failed", failure: "interval" } : { state: "answered", failure: null });
});
it("reads chat interval defaults and trimmed integer overrides", () => {
  expect(chatNushiLimits({})).toEqual({ intervalSeconds: 60, intervalLimit: 2 });
  expect(chatNushiLimits({ VILLAGE_CHAT_NUSHI_INTERVAL_SECONDS: " ", VILLAGE_CHAT_NUSHI_INTERVAL_LIMIT: "" })).toEqual({ intervalSeconds: 60, intervalLimit: 2 });
  expect(chatNushiLimits({ VILLAGE_CHAT_NUSHI_INTERVAL_SECONDS: " 90 ", VILLAGE_CHAT_NUSHI_INTERVAL_LIMIT: "4" })).toEqual({ intervalSeconds: 90, intervalLimit: 4 });
});
it.each(["VILLAGE_CHAT_NUSHI_INTERVAL_SECONDS", "VILLAGE_CHAT_NUSHI_INTERVAL_LIMIT"])("rejects invalid %s at chat startup without affecting posting-only startup", key => {
  for (const value of ["0", "-1", "1.5", "invalid", "1000001", "9007199254740992"]) {
    const env = { TRANSLATION_PRIMARY: "fake", VILLAGE_CHAT_NUSHI: "1", [key]: value };
    expect(() => chatNushiLimits(env)).toThrow(`Invalid ${key}`);
    expect(() => assertNushiConfig(env)).toThrow(`Invalid ${key}`);
    expect(() => assertNushiConfig({ ...env, VILLAGE_CHAT_NUSHI: "0", VILLAGE_NUSHI: "1" })).not.toThrow();
  }
});
it("includes the direct reply target in translation and audited report review without following its parent", async () => {
  const w = await world();
  const grand = await mutateChat(w.db, "zcn_reader", w.village.slug!, "send", { body: "UNRELATED_GRANDPARENT" });
  const parent = await mutateChat(w.db, "zcn_reader", w.village.slug!, "send", { body: "DIRECT_REPLY_CONTEXT", replyToId: grand.id });
  for (let i = 0; i < 4; i++) await mutateChat(w.db, "zcn_reader", w.village.slug!, "send", { body: `Recent ${i}` });
  const c = await w.call("An ordinary human reply", { replyToId: parent.id });
  await w.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION - 1 }).where(eq(chatConsents.userId, "zcn_reader"));
  const context = await chatTranslationSource(w.db, { messageId: c.sent.id, lang: "ja", sourceHash: chatSourceHash("An ordinary human reply") });
  expect(context?.context).toContain("DIRECT_REPLY_CONTEXT"); expect(context?.context).not.toContain("UNRELATED_GRANDPARENT");
  await w.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION }).where(eq(chatConsents.userId, "zcn_reader"));
  const report = await createChatReport(w.db, "zcn_reader", { slug: w.village.slug!, messageId: c.sent.id, reason: "other" });
  const actor = { id: "zcn_mod", scope: { operator: true, langs: ["en"] as const } };
  const evidence = await readChatEvidence(w.db, actor, { kind: "report", id: report.id }, { intent: "open" });
  expect(evidence.snapshot?.reply).toMatchObject({ text: "DIRECT_REPLY_CONTEXT" });
  expect(JSON.stringify(evidence)).not.toContain("UNRELATED_GRANDPARENT");
});
it("adds no chat AI reads or disclosure when disabled", async () => {
  const w = await world(); vi.stubEnv("VILLAGE_CHAT_NUSHI", "0");
  await expireChatNushiRequests({ select() { throw new Error("Unexpected database read"); } } as never);
  const page = aiUsePage("en", { VILLAGE_NUSHI: "0", VILLAGE_CHAT_NUSHI: "0" });
  expect(page.nushi).toBeNull(); expect(page.rows.some(row => row.purpose === "chat-nushi")).toBe(false);
  expect(await countUnreadNotifications(w.db, "zcn_outside")).toBe(0);
});

it("shares the member allowance with public calls", async () => {
  const w = await world(); vi.stubEnv("VILLAGE_NUSHI", "1"); vi.stubEnv("VILLAGE_NUSHI_MEMBER_DAILY_LIMIT", "1");
  const post = await createTopic(w.db, "zcn_caller", { body: "@nushi orchard", lang: "en", village: w.village.slug });
  if (!post.ok) throw new Error(post.error);
  const { nushiRequests, nushiAnswers } = await import("~/lib/db/schema");
  const { processNushiRequest } = await import("~/lib/nushi.server");
  const [request] = await w.db.select().from(nushiRequests);
  await processNushiRequest(w.db, request.id);
  expect(await w.db.select().from(nushiAnswers)).toHaveLength(1);
  const c = await w.call(); await processChatNushiRequest(w.db, c.request.id);
  expect((await w.db.select().from(chatNushiRequests))[0]).toMatchObject({ state: "failed", failure: "limit" });
});
it("reports an AI answer through audited chat moderation, with no author notification", async () => {
  const w = await world(), c = await w.call(); await processChatNushiRequest(w.db, c.request.id);
  const [answer] = await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"));
  const report = await createChatReport(w.db, "zcn_reader", { slug: w.village.slug!, messageId: answer.id, reason: "other" });
  const actor = { id: "zcn_mod", scope: { operator: true, langs: ["en"] as const } };
  const evidence = await readChatEvidence(w.db, actor, { kind: "report", id: report.id }, { intent: "open" });
  expect(evidence.snapshot?.body).toBe(answer.body); expect(evidence.snapshot?.author).toBe("nushi");
  const { moderateChatReport } = await import("~/lib/village-chat-reports.server");
  await moderateChatReport(w.db, actor, { reportId: report.id, intent: "hide", reason: "other", note: "The source guide needs review." });
  expect((await w.db.select().from(chatMessages).where(eq(chatMessages.id, answer.id)))[0].hiddenAt).not.toBeNull();
});
it("does not notify cited authors without current chat access, and hides citations after departure", async () => {
  const w = await world();
  await w.db.delete(chatConsents).where(eq(chatConsents.userId, "zcn_owner"));
  const c = await w.call(); await processChatNushiRequest(w.db, c.request.id);
  expect((await w.db.select().from(notifications)).filter(n => n.kind === "chat_nushi_cited")).toEqual([]);
  await consentChatMembers(w.db); const next = await w.call(); await processChatNushiRequest(w.db, next.request.id);
  expect((await listNotifications(w.db, "zcn_owner")).items).toHaveLength(1);
  await w.db.delete(villageMembers).where(eq(villageMembers.userId, "zcn_owner"));
  expect((await listNotifications(w.db, "zcn_owner")).items).toEqual([]);
});
it.skipIf(!PG_MODE)("serializes duplicate claims and shares concurrent capacity across destinations on PostgreSQL", { tags: ["postgres"] }, async () => {
  const w = await world(), c = await w.call();
  const { resolveNushiCompleter, processNushiRequest } = await import("~/lib/nushi.server");
  const { nushiRequests } = await import("~/lib/db/schema");
  vi.stubEnv("VILLAGE_NUSHI", "1"); vi.stubEnv("VILLAGE_NUSHI_CONCURRENT_LIMIT", "1");
  const post = await createTopic(w.db, "zcn_caller", { body: "@nushi orchard", lang: "en", village: w.village.slug });
  if (!post.ok) throw new Error(post.error);
  const [request] = await w.db.select().from(nushiRequests);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  const fake = resolveNushiCompleter();
  const first = processChatNushiRequest(w.db, c.request.id, { completer: { ...fake, async complete(req) { entered(); await waiting; return fake.complete(req); } } });
  await started;
  try {
    await expect(processChatNushiRequest(w.db, c.request.id)).rejects.toMatchObject({ name: "DeferJob" });
    await expect(processNushiRequest(w.db, request.id)).rejects.toMatchObject({ name: "DeferJob" });
  } finally { release(); }
  await first;
  expect(await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"))).toHaveLength(1);
});
it("keeps verified quotations and destinations unchanged when translating an AI answer", async () => {
  const w = await world(), c = await w.call(); await processChatNushiRequest(w.db, c.request.id);
  const [answer] = await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"));
  const { translateChatNushi } = await import("~/lib/chat-nushi-translation.server");
  const translated = await translateChatNushi(w.db, answer, "ja", { clock: () => new Date() });
  const last = answer.nushiShape!.ranges.at(-1)![1];
  expect(translated.text.slice(translated.text.indexOf(" [1]"))).toBe(answer.body.slice(last));
  const { chatMentionCounts } = await import("~/lib/village-chat-notifications.server");
  expect((await chatMentionCounts(w.db, "zcn_caller")).size).toBe(0);
});
it("shows a failed request only to its caller and never groups it with human notices", async () => {
  const w = await world(), c = await w.call();
  vi.stubEnv("VILLAGE_NUSHI_LLM_MONTHLY_BUDGET_USD", "0");
  await processChatNushiRequest(w.db, c.request.id);
  const own = (await chatPage(w.db, "zcn_caller", w.village.slug!))!;
  const other = (await chatPage(w.db, "zcn_reader", w.village.slug!))!;
  if (own.consentRequired || other.consentRequired) throw new Error("Missing consent");
  expect(own.messages[0]).toMatchObject({ nushiCall: { state: "failed", failure: "budget" } });
  expect(other.messages[0]).not.toHaveProperty("nushiCall");
  const { groupChatNotifications } = await import("~/lib/group-chat-notifications");
  const base = { read: false, actorHandle: "zcn_reader", chat: { slug: w.village.slug! } };
  expect(groupChatNotifications([{ ...base, id: 1, kind: "chat_reply" }, { ...base, id: 2, kind: "chat_nushi_result" }])).toHaveLength(2);
});

it("withdraws on supplied translation changes without disrupting ordinary translation writes", async () => {
  const w = await world(), c = await w.call(); await processChatNushiRequest(w.db, c.request.id);
  const { translations } = await import("~/lib/db/schema");
  const [source] = await w.db.select().from(entries).where(eq(entries.id, w.source));
  const [translation] = await w.db.insert(translations).values({ entryId: w.source, field: "body", lang: "ja", kind: "primary", text: "Original supplied translation", sourceHash: source.sourceHash }).returning();
  await w.db.update(translations).set({ text: "Revised supplied translation" }).where(eq(translations.id, translation.id));
  const [answer] = await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"));
  expect(answer).toMatchObject({ body: "", hiddenAt: expect.any(Date) });
});
it("preserves hidden messages inside the audited report context while hiding their reply preview", async () => {
  const w = await world();
  const parent = await mutateChat(w.db, "zcn_reader", w.village.slug!, "send", { body: "HIDDEN_DIRECT_REFERENCE" });
  const c = await w.call("An ordinary reply", { replyToId: parent.id });
  const report = await createChatReport(w.db, "zcn_reader", { slug: w.village.slug!, messageId: c.sent.id, reason: "other" });
  await w.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, parent.id));
  const actor = { id: "zcn_mod", scope: { operator: true, langs: ["en"] as const } };
  const evidence = await readChatEvidence(w.db, actor, { kind: "report", id: report.id }, { intent: "context" });
  expect(evidence.context.find(message => message.id === parent.id)?.body).toBe("HIDDEN_DIRECT_REFERENCE");
  expect(evidence.context.find(message => message.id === c.sent.id)?.reply).toMatchObject({ unavailable: true });
});

it.each(["hidden", "deleted"])("does not fetch a %s reply target outside the audited report context", async state => {
  const w = await world();
  const parent = await mutateChat(w.db, "zcn_reader", w.village.slug!, "send", { body: "PRIVATE_OUTSIDE_REFERENCE" });
  for (let i = 0; i <= CHAT_CASE_CONTEXT_COUNT; i++) await w.db.insert(chatMessages).values({ villageId: w.village.id, authorId: "zcn_reader", body: `Context ${i}`, lang: "en", createdSeq: i + 2, changedSeq: i + 2 });
  const { chatSequences } = await import("~/lib/db/schema");
  await w.db.update(chatSequences).set({ seq: CHAT_CASE_CONTEXT_COUNT + 2 }).where(eq(chatSequences.villageId, w.village.id));
  const c = await w.call("An ordinary reply", { replyToId: parent.id });
  const report = await createChatReport(w.db, "zcn_reader", { slug: w.village.slug!, messageId: c.sent.id, reason: "other" });
  if (state === "hidden") await w.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, parent.id));
  else await mutateChat(w.db, "zcn_reader", w.village.slug!, "delete", { id: parent.id });
  const actor = { id: "zcn_mod", scope: { operator: true, langs: ["en"] as const } };
  for (const intent of ["open", "context"] as const) {
    const evidence = await readChatEvidence(w.db, actor, { kind: "report", id: report.id }, { intent });
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_OUTSIDE_REFERENCE");
    const reply = intent === "open" ? evidence.snapshot?.reply : evidence.context.find(message => message.id === c.sent.id)?.reply;
    expect(reply).toMatchObject({ unavailable: true });
  }
});

it.each([false, true])("excludes an AI reply target from translation context even when recent=%s", async recent => {
  const w = await world(), c = await w.call(); await processChatNushiRequest(w.db, c.request.id);
  const [answer] = await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"));
  if (!recent) await w.db.update(chatMessages).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(chatMessages.id, answer.id));
  const body = "A human follow-up";
  const reply = await mutateChat(w.db, "zcn_reader", w.village.slug!, "send", { body, replyToId: answer.id });
  const context = await chatTranslationSource(w.db, { messageId: reply.id, lang: "ja", sourceHash: chatSourceHash(body) });
  expect(context?.context).toContain("@nushi orchard");
  expect(context?.context).not.toContain(answer.body);
});

it.each([false, true].flatMap(omitReadings => [undefined, false, true].flatMap(clarificationNeeded => [undefined, false, true].map(askPerson => ({ omitReadings, clarificationNeeded, askPerson })))))("publishes a not-found answer with omitted readings=$omitReadings and clarificationNeeded=$clarificationNeeded and askPerson=$askPerson", async ({ omitReadings, clarificationNeeded, askPerson }) => {
  const w = await world(), c = await w.call(clarificationNeeded ? "@nushi ?" : "@nushi orchard planting date");
  await processChatNushiRequest(w.db, c.request.id, { completer: { engine: "fake", model: "fake", async complete(req) {
    expect(req.system).toContain(CHAT_NUSHI_PROMPT_VERSION);
    return { text: JSON.stringify({ status: "not_confirmed", ...(omitReadings ? {} : { readings: [] }), clarificationNeeded, askPerson }), inputTokens: 1, outputTokens: 1 };
  } } });
  expect((await w.db.select().from(chatNushiRequests))[0]).toMatchObject({ state: "answered", failure: null });
  const [answer] = await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"));
  expect(answer).toMatchObject({ body: [m.nushi_not_found(), ...(askPerson === true ? [m.nushi_ask_person()] : []), ...(clarificationNeeded === true ? [m.chat_nushi_clarify()] : [])].join(" "), nushiShape: { status: "not_confirmed", ranges: [], clarificationNeeded: clarificationNeeded === true, askPerson: askPerson === true } });
  expect((await w.db.select().from(notifications)).filter(n => n.kind === "chat_nushi_result")).toMatchObject([{ userId: "zcn_caller", chatMessageId: answer.id }]);
  expect((await w.db.select().from(notifications)).filter(n => n.kind === "chat_nushi_cited")).toEqual([]);
});

it.each([false, true].flatMap(legacy => (["en", "ja"] as const).flatMap(sourceLang => [false, true].flatMap(clarificationNeeded => [false, true].map(askPerson => ({ legacy, sourceLang, clarificationNeeded, askPerson }))))))("preserves clarification=$clarificationNeeded and person guidance=$askPerson when reading a not-found answer from $sourceLang in another language (legacy=$legacy)", async ({ legacy, sourceLang, clarificationNeeded, askPerson }) => {
  const w = await world(), c = await w.call();
  await processChatNushiRequest(w.db, c.request.id, { completer: { engine: "fake", model: "fake", async complete() {
    return { text: JSON.stringify({ status: "not_confirmed", readings: [], clarificationNeeded, askPerson }), inputTokens: 1, outputTokens: 1 };
  } } });
  const [answer] = await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"));
  expect(answer).toBeDefined();
  await w.db.update(chatMessages).set({ lang: sourceLang, body: [m.nushi_not_found({}, { locale: sourceLang }), ...(askPerson ? [m.nushi_ask_person({}, { locale: sourceLang })] : []), ...(clarificationNeeded ? [m.chat_nushi_clarify({}, { locale: sourceLang })] : [])].join(" "), ...(legacy ? { nushiShape: { status: "not_confirmed" as const, ranges: [] } } : {}) }).where(eq(chatMessages.id, answer.id));
  const language = sourceLang === "en" ? "ja" : "en";
  await w.db.update(profiles).set({ displayLang: language, readLangs: [language], uiLocale: language }).where(eq(profiles.userId, "zcn_reader"));
  await chatPage(w.db, "zcn_reader", w.village.slug!);
  const result = await runDueJobs(w.db, createChatTranslationHandlers());
  expect(result).toMatchObject({ failed: 0, retried: 0 });
  const page = (await chatPage(w.db, "zcn_reader", w.village.slug!))!;
  if (page.consentRequired) throw new Error("Consent missing");
  const translated = page.messages.find(message => message.id === answer.id)!.translation;
  expect(translated).toMatchObject({ state: "ready", lang: language, text: [m.nushi_not_found({}, { locale: language }), ...(askPerson ? [m.nushi_ask_person({}, { locale: language })] : []), ...(clarificationNeeded ? [m.chat_nushi_clarify({}, { locale: language })] : [])].join(" ") });
});

it.each(["missing-answered-readings", "nonempty-not-confirmed-readings", "null-not-confirmed-readings"])("rejects %s without publishing an answer", async mode => {
  const w = await world(), c = await w.call();
  await processChatNushiRequest(w.db, c.request.id, { completer: { engine: "fake", model: "fake", async complete() {
    const response = mode === "missing-answered-readings" ? { status: "answered" }
      : { status: "not_confirmed", readings: mode === "null-not-confirmed-readings" ? null : [{ text: "The owner calls for public review.", citations: [{ sourceId: `e-${w.source}-body`, quote: "The orchard needs public review." }] }] };
    return { text: JSON.stringify(response), inputTokens: 1, outputTokens: 1 };
  } } });
  expect((await w.db.select().from(chatNushiRequests))[0]).toMatchObject({ state: "failed", failure: "unverified" });
  expect(await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"))).toEqual([]);
});

it.each(["clarificationNeeded", "askPerson"].flatMap(field => ["PROVIDER_TEXT", null, 1, [], {}].map(value => ({ field, value }))))("rejects invalid $field=$value without publishing provider text", async ({ field, value }) => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const w = await world(), c = await w.call();
  await processChatNushiRequest(w.db, c.request.id, { completer: { engine: "fake", model: "fake", async complete() {
    return { text: JSON.stringify({ status: "not_confirmed", readings: [], [field]: value }), inputTokens: 1, outputTokens: 1 };
  } } });
  expect((await w.db.select().from(chatNushiRequests))[0]).toMatchObject({ state: "failed", failure: "unverified" });
  expect(await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"))).toEqual([]);
  expect(log.mock.calls).toEqual([["Nushi answer verification failed", { requestId: c.request.id, reason: "schema", counts: { readings: 0, citations: 0 } }]]);
});

it("does not advance withdrawn answer cursors on later village updates", async () => {
  const w = await world(), c = await w.call(); await processChatNushiRequest(w.db, c.request.id);
  await w.db.update(villages).set({ nushiEnabled: false }).where(eq(villages.id, w.village.id));
  const [withdrawn] = await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"));
  expect(withdrawn).toMatchObject({ body: "", hiddenAt: expect.any(Date) });
  await w.db.update(villages).set({ name: "Updated village" }).where(eq(villages.id, w.village.id));
  expect((await w.db.select().from(chatMessages).where(eq(chatMessages.id, withdrawn.id)))[0].changedSeq).toBe(withdrawn.changedSeq);
});

it("applies hiding only to the reader's answer and reply previews", async () => {
  const w = await world(), c = await w.call(); await processChatNushiRequest(w.db, c.request.id);
  const [answer] = await w.db.select().from(chatMessages).where(eq(chatMessages.authorKind, "nushi"));
  const human = await mutateChat(w.db, "zcn_caller", w.village.slug!, "send", { body: "A human response", replyToId: answer.id });
  await w.db.update(profiles).set({ hideNushi: true }).where(eq(profiles.userId, "zcn_reader"));
  const reader = (await chatPage(w.db, "zcn_reader", w.village.slug!))!, caller = (await chatPage(w.db, "zcn_caller", w.village.slug!))!;
  if (reader.consentRequired || caller.consentRequired) throw new Error("Missing consent");
  expect(reader.messages.find(m => m.id === answer.id)).toMatchObject({ hidden: true, parts: [] });
  expect(reader.messages.find(m => m.id === human.id)?.reply).toMatchObject({ unavailable: true });
  expect(caller.messages.find(m => m.id === answer.id)).toMatchObject({ hidden: false });
});

it("assigns separate change cursors when one source withdraws more answers than a change page", async () => {
  const w = await world();
  const { chatSequences } = await import("~/lib/db/schema");
  const calls = await w.db.insert(chatMessages).values(Array.from({ length: 101 }, (_, i) => ({ villageId: w.village.id, authorId: "zcn_caller", lang: "en", body: `Call ${i}`, createdSeq: i + 1, changedSeq: i + 1 }))).returning();
  const answers = await w.db.insert(chatMessages).values(calls.map((call, i) => ({ villageId: w.village.id, authorKind: "nushi", authorId: null, replyToId: call.id, lang: "en", body: `OLD_AI_QUOTE ${i}`, createdSeq: i + 102, changedSeq: i + 102 }))).returning();
  const requests = await w.db.insert(chatNushiRequests).values(calls.map((call, i) => ({ messageId: call.id, answerMessageId: answers[i].id, callerId: "zcn_caller", villageId: w.village.id, state: "answered", expiresAt: new Date(Date.now() + 60000) }))).returning();
  await w.db.insert(chatNushiSources).values(requests.map(request => ({ requestId: request.id, entryId: w.source, revision: 1, sourceHash: "fixture", authorId: "zcn_owner" })));
  await w.db.insert(chatSequences).values({ villageId: w.village.id, seq: 202 });
  await w.db.update(entries).set({ body: "Revised source for all answers" }).where(eq(entries.id, w.source));
  const first = await chatChanges(w.db, "zcn_reader", w.village.slug!, { since: 202 });
  expect(first.more).toBe(true); expect(first.messages).toHaveLength(100);
  const second = await chatChanges(w.db, "zcn_reader", w.village.slug!, { since: first.next });
  expect(second.messages).toHaveLength(1);
  expect(new Set([...first.messages, ...second.messages].map(message => message.id)).size).toBe(101);
  expect(JSON.stringify([first, second])).not.toContain("OLD_AI_QUOTE");
});
