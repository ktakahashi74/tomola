import { renderNushiThread } from "~/lib/nushi-html.server";
import { createNushiTranslationHandlers } from "~/lib/nushi-translations.server";
import { runRetentionCleanup } from "~/lib/retention.server";
import { nushiFixture } from "./helpers/nushi";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { createReply, createTopic } from "~/lib/entries.server";
import { EMBEDDING_DIM, entries, entryEmbeddings, jobs, llmUsage, moderationActions, notifications, nushiAnswers, nushiReports, nushiRequests, nushiReservations, nushiSources, nushiTranslations, profiles, translations, villageMembers, villages } from "~/lib/db/schema";
import { callsNushi } from "~/lib/nushi-call.server";
import { NUSHI_PROMPT_VERSION, nushiEnabled, nushiInVillage, nushiLimits, nushiMonthlyBudgetMicro } from "~/lib/nushi-config.server";
import { expireNushiRequests, nushiPrompt, processNushiRequest, readNushiAnswer, threadNushi, requestNushi, resolveNushiCompleter } from "~/lib/nushi.server";
import { questionPrompt } from "~/lib/ai-question-answer.server";
import { nushiMaterials } from "~/lib/nushi-materials.server";
import { setTopicNushi, setVillageNushi } from "~/lib/nushi-settings.server";
import { listNushiReports, reportNushi, resolveNushiReport } from "~/lib/nushi-reports.server";
import { nushiMarkdownBlocks } from "~/lib/nushi-markdown.server";
import { getBudgetStatus, NUSHI_USAGE_PURPOSES, reserveUsage } from "~/lib/llm/usage.server";
import type { Db } from "~/lib/db/client.server";
import type { JsonCompleter } from "~/lib/llm/completion.server";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function published(f: Awaited<ReturnType<typeof nushiFixture>>, completer?: JsonCompleter) {
  await processNushiRequest(f.db, f.request.id, { completer });
  const [answer] = await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, f.request.id));
  expect(answer).toBeDefined();
  return answer;
}

it("recognizes exact calls outside Markdown quotes, code, links and escapes", async () => {
  for (const body of ["@nushi orchard", "@village-ai orchard", "＠ｎｕｓｈｉ orchard", "> @nushi\n\n@nushi", "**@nushi**"]) expect(await callsNushi(body), body).toBe(true);
  for (const body of ["> @nushi", "`@nushi`", "```\n@nushi\n```", "    @nushi", "[go](https://example.org/@nushi)", "\\@nushi", "&#64;nushi", "a@nushi", "@nushix", "@nushi-more"]) expect(await callsNushi(body), body).toBe(false);
});
it("keeps the public prompt as the default while selecting a private chat destination explicitly", async () => {
  const f = await nushiFixture();
  const input = (await nushiMaterials(f.db, f.request, { env: process.env, now: new Date(), clock: () => new Date() }))!;
  const publicPrompt = nushiPrompt(input);
  expect(publicPrompt).toEqual(nushiPrompt(input, "public-reply"));
  expect(publicPrompt.system).toContain("This answer will be a public AI reply");
  const chatPrompt = nushiPrompt(input, "chat");
  expect(chatPrompt.user).toBe(publicPrompt.user);
  expect(chatPrompt.system).toContain("This answer will be a private chat AI reply");
  expect(publicPrompt.system).toContain("When the question refers to the calling topic itself");
  expect(chatPrompt.system).not.toContain("When the question refers to the calling topic itself");
  expect(chatPrompt.system).toContain("you may add askPerson as a JSON boolean");
});
it("defaults off, separates its budget, and excludes language and closed villages", () => {
  expect(nushiEnabled({})).toBe(false); expect(nushiMonthlyBudgetMicro({})).toBe(10_000_000);
  expect(nushiLimits({})).toMatchObject({ member: 5, topic: 10, village: 30, author: 10, concurrent: 2, ttlSeconds: 3600 });
  const env = { VILLAGE_NUSHI: "1", PUBLIC_READING: "1", VILLAGES: "1" };
  const place = { kind: "open", slug: "example", language: null, endedAt: null, nushiEnabled: null };
  expect(nushiInVillage(place, env)).toBe(true);
  expect(nushiInVillage({ ...place, kind: "personal", slug: null }, env)).toBe(false);
  expect(nushiInVillage({ ...place, kind: "personal", slug: null, nushiEnabled: true }, env)).toBe(true);
  expect(nushiInVillage({ ...place, language: "en" }, env)).toBe(false);
  expect(nushiInVillage({ ...place, kind: "closed" }, env)).toBe(false);
  expect(nushiInVillage(place, { ...env, PUBLIC_READING: "" })).toBe(false);
});
it("publishes one sourced AI reply without adding a member, human reply, ranking activity or embedding", async () => {
  const f = await nushiFixture();
  const [before] = await f.db.select().from(entries).where(eq(entries.id, f.topic));
  const answer = await published(f);
  expect(answer.promptVersion).toBe(NUSHI_PROMPT_VERSION);
  await processNushiRequest(f.db, f.request.id);
  await requestNushi(f.db, f.topic);
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(1);
  expect(await f.db.select().from(nushiRequests)).toHaveLength(1);
  const [after] = await f.db.select().from(entries).where(eq(entries.id, f.topic));
  expect(after.replyCount).toBe(before.replyCount); expect(after.lastActivityAt).toEqual(before.lastActivityAt);
  expect(await f.db.select().from(profiles)).toHaveLength(3);
  expect(await f.db.select().from(entryEmbeddings)).toHaveLength(0);
  const view = await readNushiAnswer(f.db, answer.id);
  expect(view && !view.hidden && view.answer.citations[0].author).toBe("@znushi_owner");
  const notices = await f.db.select().from(notifications);
  expect(notices.map(notice => [notice.kind, notice.userId]).sort()).toEqual([["nushi_cited", "nushi-owner"], ["nushi_result", "nushi-caller"]]);
  expect(JSON.stringify(notices)).not.toContain("orchard");
  expect((await f.db.select().from(llmUsage)).every(row => row.purpose === "ask_village")).toBe(true);
  expect((await nushiMarkdownBlocks(f.db, f.topic, [f.topic], "en")).join("\n")).toContain("author_kind: ai");
});
it("does not call from a suppressed post, an edit, a quote or a non-public place", async () => {
  const f = await nushiFixture();
  for (const input of [{ body: "@nushi orchard", suppressNushi: true }, { body: "> @nushi orchard" }, { body: "```\n@nushi orchard\n```" }]) {
    const reply = await createReply(f.db, "nushi-caller", f.topic, { ...input, lang: "en" }); expect(reply.ok).toBe(true);
  }
  await setTopicNushi(f.db, "nushi-caller", f.topic, true);
  const reply = await createReply(f.db, "nushi-owner", f.topic, { body: "@nushi orchard", lang: "en" }); expect(reply.ok).toBe(true);
  await processNushiRequest(f.db, f.request.id);
  expect(await f.db.select().from(nushiRequests)).toHaveLength(1); expect(await f.db.select().from(llmUsage)).toHaveLength(0);
});
it("keeps all evidence in the same publicly readable village", async () => {
  const f = await nushiFixture();
  const [other] = await f.db.insert(villages).values({ kind: "open", slug: "different-village" }).returning();
  await f.db.insert(villageMembers).values({ villageId: other.id, userId: "nushi-owner", role: "owner" });
  await createTopic(f.db, "nushi-owner", { body: "orchard FOREIGN_SECRET_MARKER", lang: "en", village: other.slug });
  const hidden = await createReply(f.db, "nushi-owner", f.source, { body: "orchard HIDDEN_SECRET_MARKER", lang: "en" });
  if (!hidden.ok) throw new Error(hidden.error);
  await f.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hidden.id));
  const materials = await nushiMaterials(f.db, f.request, { env: process.env, now: new Date(), clock: () => new Date() });
  expect(JSON.stringify(materials)).not.toMatch(/FOREIGN_SECRET_MARKER|HIDDEN_SECRET_MARKER/);
});
it("publishes translated Markdown evidence and saves exactly the projected model materials", async () => {
  const f = await nushiFixture();
  await f.db.update(entries).set({ body: "Orchard **bold** and [link](https://example.org/URL_SECRET). $a + \\phantom{MATH_SECRET}$ <!-- BODY_SECRET -->" }).where(eq(entries.id, f.source));
  const [source] = await f.db.select().from(entries).where(eq(entries.id, f.source));
  await f.db.insert(translations).values({ entryId: f.source, field: "body", lang: "ja", kind: "primary", text: "果樹園の**強調**と[リンク](https://example.org/TRANSLATED_URL_SECRET)。 <!-- TRANSLATION_SECRET -->", sourceHash: source.sourceHash });
  const topic = await createTopic(f.db, "nushi-caller", { title: "1. # <T> 果樹園\u200b", body: "話題の**文** [リンク](https://example.org/TOPIC_SECRET) <!-- TOPIC_COMMENT_SECRET -->", lang: "ja", village: f.village.slug });
  if (!topic.ok) throw new Error(topic.error);
  const parent = await createReply(f.db, "nushi-caller", topic.id, { body: "親の**文** <!-- PARENT_SECRET -->", lang: "ja" });
  if (!parent.ok) throw new Error(parent.error);
  const call = await createReply(f.db, "nushi-caller", topic.id, { body: "@nushi orchard **問い** [リンク](https://example.org/CALL_SECRET) <!-- CALL_COMMENT_SECRET -->", lang: "ja", parentId: parent.id });
  if (!call.ok) throw new Error(call.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, call.id));
  let modelMaterials: unknown, modelQuestion: string | undefined;
  const fake = resolveNushiCompleter();
  const { resolveEmbeddingEngine } = await import("~/lib/llm/config.server");
  const embedding = resolveEmbeddingEngine({ EMBEDDING_ENGINE: "fake" });
  await processNushiRequest(f.db, request.id, { embedding: { ...embedding, async embed(req) {
    expect(req.text).toBe("orchard 問い リンク");
    return embedding.embed(req);
  } }, completer: { ...fake, async complete(req) {
    const input = JSON.parse(req.user);
    modelMaterials = input.materials; modelQuestion = input.context.callingPost;
    expect(req.user).not.toContain("SECRET");
    expect(input.context).toMatchObject({ callingPost: "@nushi orchard 問い リンク", parentPost: "親の文", topic: { title: "1. # <T> 果樹園", body: "話題の文 リンク" } });
    const material = input.materials.find((s: { id: string }) => s.id === `e-${f.source}-body`);
    expect(material).toMatchObject({ original: expect.stringContaining("Orchard bold and link."), translation: { text: "果樹園の強調とリンク。", lang: "ja" } });
    return { text: JSON.stringify({ status: "answered", readings: [{ text: "果樹園の出典。", citations: [{ sourceId: material.id, quote: "Orchard bold and link.", translatedQuote: "果樹園の強調とリンク。" }] }] }), inputTokens: 1, outputTokens: 1 };
  } } });
  expect((await f.db.select().from(nushiRequests).where(eq(nushiRequests.id, request.id)))[0]).toMatchObject({ state: "answered" });
  const [answer] = await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, request.id));
  expect(await reportNushi(f.db, "nushi-follower", { answerId: answer.id, kind: "error", reason: "wrong_post", note: "Check the translated source.", consent: true })).toBe(true);
  const [report] = await f.db.select().from(nushiReports);
  const evidence = report.evidence as { materials: Array<Record<string, unknown>>; question: string };
  expect(evidence.materials.map(({ href: _href, sourceHash: _hash, ...material }) => material)).toEqual(modelMaterials);
  expect(evidence.question).toBe(modelQuestion);
  expect(JSON.stringify(evidence)).not.toContain("SECRET");
});
it("rejects invented quotes and untrusted output fields without publishing", async () => {
  const f = await nushiFixture();
  const fake = resolveNushiCompleter();
  await processNushiRequest(f.db, f.request.id, { completer: { ...fake, async complete() { return { text: JSON.stringify({ status: "answered", readings: [{ text: "Invented evidence", citations: [{ sourceId: `e-${f.source}-body`, quote: "THIS DOES NOT EXIST" }] }] }), inputTokens: 1, outputTokens: 1 }; } } });
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(0);
  expect((await f.db.select().from(nushiRequests))[0]).toMatchObject({ state: "failed", failure: "unverified" });
});
it.each(["source", "caller", "village", "topic", "switch"])("does not publish across a concurrent %s change", async kind => {
  const f = await nushiFixture(), fake = resolveNushiCompleter();
  const engine: JsonCompleter = { ...fake, async complete(req) {
    const out = await fake.complete(req);
    if (kind === "source") await f.db.update(entries).set({ body: "A revised source." }).where(eq(entries.id, f.source));
    if (kind === "caller") await f.db.update(entries).set({ body: "A revised question." }).where(eq(entries.id, f.topic));
    if (kind === "village") await setVillageNushi(f.db, "nushi-owner", f.village.id, false);
    if (kind === "topic") await setTopicNushi(f.db, "nushi-caller", f.topic, true);
    if (kind === "switch") vi.stubEnv("VILLAGE_NUSHI", "");
    return out;
  } };
  await processNushiRequest(f.db, f.request.id, { completer: engine });
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(0);
});
it.each(["body", "hidden", "deleted"])("withdraws all representations permanently after a source %s change", async kind => {
  const f = await nushiFixture(), answer = await published(f);
  await f.db.update(entries).set(kind === "body" ? { body: "Corrected without private details." } : kind === "hidden" ? { hiddenAt: new Date() } : { deletedAt: new Date() }).where(eq(entries.id, f.source));
  expect(await readNushiAnswer(f.db, answer.id)).toMatchObject({ hidden: true });
  const markdown = (await nushiMarkdownBlocks(f.db, f.topic, [f.topic], "en")).join("\n");
  expect(markdown).not.toContain("orchard plan");
  await f.db.update(entries).set({ hiddenAt: null, deletedAt: null }).where(eq(entries.id, f.source));
  expect(await readNushiAnswer(f.db, answer.id)).toMatchObject({ hidden: true });
});
it("keeps only globally hidden answers when the switch is restored; owner opt-out is permanent", async () => {
  const f = await nushiFixture(), answer = await published(f);
  vi.stubEnv("VILLAGE_NUSHI", ""); expect(await readNushiAnswer(f.db, answer.id)).toMatchObject({ hidden: true });
  vi.stubEnv("VILLAGE_NUSHI", "1"); expect(await readNushiAnswer(f.db, answer.id)).toMatchObject({ hidden: false });
  expect(await setVillageNushi(f.db, "nushi-caller", f.village.id, false)).toBe(false);
  await setVillageNushi(f.db, "nushi-owner", f.village.id, false);
  await setVillageNushi(f.db, "nushi-owner", f.village.id, true);
  expect(await readNushiAnswer(f.db, answer.id)).toMatchObject({ hidden: true });
});
it("supports follow-up replies while keeping the previous AI output out of evidence", async () => {
  const f = await nushiFixture(), answer = await published(f);
  const followup = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi orchard timing?", lang: "en", nushiParentId: answer.id });
  if (!followup.ok) throw new Error(followup.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, followup.id));
  const materials = await nushiMaterials(f.db, request, { env: process.env, now: new Date(), clock: () => new Date() });
  expect(materials?.context).toHaveProperty("previousAiReply");
  expect(materials?.materials.sources.every(source => /^e-\d+-/.test(source.id))).toBe(true);
  const invalid = await createReply(f.db, "nushi-caller", f.source, { body: "Wrong thread", lang: "en", nushiParentId: answer.id });
  expect(invalid).toMatchObject({ ok: false, error: "parent_not_in_thread" });
});
it("expires requests and enforces member, topic, village and cited-author allowances", async () => {
  const f = await nushiFixture();
  await expireNushiRequests(f.db, new Date(f.request.expiresAt.getTime() + 1));
  expect((await f.db.select().from(nushiRequests))[0]).toMatchObject({ state: "failed", failure: "expired" });
  const reply = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi orchard", lang: "en" });
  if (!reply.ok) throw new Error(reply.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, reply.id));
  await f.db.insert(nushiReservations).values({ requestId: f.request.id, key: "member:nushi-caller", day: new Date().toISOString().slice(0, 10) });
  await processNushiRequest(f.db, request.id, { env: { ...process.env, VILLAGE_NUSHI_MEMBER_DAILY_LIMIT: "1" } });
  expect((await f.db.select().from(nushiRequests).where(eq(nushiRequests.id, request.id)))[0]).toMatchObject({ state: "failed", failure: "limit" });
});
it("uses a separate hard monthly budget and refuses a zero budget before sending text", async () => {
  const f = await nushiFixture();
  const fake = { ...resolveNushiCompleter(), complete: vi.fn() };
  await processNushiRequest(f.db, f.request.id, { completer: fake, env: { ...process.env, VILLAGE_NUSHI_LLM_MONTHLY_BUDGET_USD: "0" } });
  expect(fake.complete).not.toHaveBeenCalled();
  expect((await f.db.select().from(nushiRequests))[0]).toMatchObject({ state: "failed", failure: "budget" });
  expect((await getBudgetStatus(f.db, new Date(), { VILLAGE_NUSHI_LLM_MONTHLY_BUDGET_USD: "0" }, NUSHI_USAGE_PURPOSES)).state).toBe("stopped");
});
it("separates ordinary reports from error reports requiring explicit evidence consent", async () => {
  const f = await nushiFixture(), answer = await published(f);
  expect(await reportNushi(f.db, "nushi-owner", { answerId: answer.id, kind: "error", reason: "wrong_post", note: "", consent: false })).toBe(false);
  expect(await reportNushi(f.db, "nushi-owner", { answerId: answer.id, kind: "error", reason: "wrong_post", note: "Please check this source.", consent: true })).toBe(true);
  expect(await reportNushi(f.db, "nushi-owner", { answerId: answer.id, kind: "moderation", reason: "other", note: "A moderation concern.", consent: false })).toBe(true);
  const reports = await listNushiReports(f.db, { reporterId: "nushi-owner" }); expect(reports).toHaveLength(2); expect(reports[0]).not.toHaveProperty("reporterId");
  await resolveNushiReport(f.db, "nushi-owner", reports[0].id, true, "Hidden after review.");
  expect(await readNushiAnswer(f.db, answer.id)).toMatchObject({ hidden: true });
});
it.each(["moderation", "source_change"])("preserves an existing %s hide when resolving another report", async reason => {
  const f = await nushiFixture(), answer = await published(f);
  for (const reporter of ["nushi-owner", "nushi-follower"]) expect(await reportNushi(f.db, reporter, { answerId: answer.id, kind: "moderation", reason: "other", note: "Review this answer.", consent: false })).toBe(true);
  const reports = await f.db.select().from(nushiReports).orderBy(nushiReports.id);
  if (reason === "moderation") await resolveNushiReport(f.db, "nushi-owner", reports[0].id, true, "First review.");
  else await f.db.update(entries).set({ body: "A corrected source." }).where(eq(entries.id, f.source));
  const [before] = await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.id, answer.id));
  const actions = await f.db.select().from(moderationActions);
  expect(before.hiddenAt).not.toBeNull();
  expect(await resolveNushiReport(f.db, "nushi-owner", reports[1].id, true, "Second review.")).toBe(true);
  expect((await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.id, answer.id)))[0]).toMatchObject({ hiddenAt: before.hiddenAt, hiddenReason: before.hiddenReason });
  expect(await f.db.select().from(moderationActions)).toEqual(actions);
  expect((await f.db.select().from(nushiReports).where(eq(nushiReports.id, reports[1].id)))[0].status).toBe("resolved");
});

it("translates generated readings and removes saved translations with a withdrawn source", async () => {
  const f = await nushiFixture(), answer = await published(f);
  const [job] = await f.db.select().from(jobs).where(and(eq(jobs.kind, "translate_nushi"), eq(jobs.dedupeKey, `nushi-translation:${answer.id}:ja`)));
  await createNushiTranslationHandlers().translate_nushi(job, { db: f.db, now: new Date() });
  const view = await readNushiAnswer(f.db, answer.id, "ja");
  expect(view && !view.hidden && view.translated).toBe(true);
  expect(view && !view.hidden && view.answer.citations).toEqual(answer.answer.citations);
  await f.db.update(entries).set({ body: "Corrected source." }).where(eq(entries.id, f.source));
  expect(await f.db.select().from(nushiTranslations)).toHaveLength(0);
  expect(await readNushiAnswer(f.db, answer.id, "ja")).toMatchObject({ hidden: true });
});
it("removes consented error evidence at its retention boundary", async () => {
  const f = await nushiFixture(), answer = await published(f);
  await reportNushi(f.db, "nushi-owner", { answerId: answer.id, kind: "error", reason: "lost_context", note: "A consented error report.", consent: true });
  const now = new Date();
  await f.db.update(nushiReports).set({ createdAt: new Date(now.getTime() - 91 * 86_400_000) });
  await runRetentionCleanup(f.db, now);
  expect(await f.db.select().from(nushiReports)).toHaveLength(0);
});

it.each(["TOPIC", "VILLAGE"])("reserves the %s daily allowance before another answer can publish", async scope => {
  const f = await nushiFixture();
  await published(f);
  const reply = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi orchard again", lang: "en" });
  if (!reply.ok) throw new Error(reply.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, reply.id));
  await processNushiRequest(f.db, request.id, { env: { ...process.env, [`VILLAGE_NUSHI_${scope}_DAILY_LIMIT`]: "1" } });
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(1);
  expect((await f.db.select().from(nushiRequests).where(eq(nushiRequests.id, request.id)))[0]).toMatchObject({ state: "failed", failure: "limit" });
});

it("escapes generated text in native server-rendered cards and forms", async () => {
  const f = await nushiFixture(), fake = resolveNushiCompleter();
  await published(f, { ...fake, async complete(req) {
    const result = await fake.complete(req), answer = JSON.parse(result.text);
    answer.readings[0].text = "A reading <img src=x onerror=alert(1)>";
    return { ...result, text: JSON.stringify(answer) };
  } });
  const view = { ...await threadNushi(f.db, f.topic, [f.topic], "en"), hide: false, citations: true, setting: false };
  const html = renderNushiThread(view, [{ id: f.topic }], { threadId: f.topic, member: true, back: `/t/${f.topic}` });
  expect(html.entries[f.topic]).toContain("&lt;img");
  expect(html.entries[f.topic]).not.toContain("<img");
  expect(html.entries[f.topic]).toContain('action="/nushi/action"');
  expect(html.controls).toContain('method="post"');
});
it("withdraws a chain of AI contexts while preserving human replies", async () => {
  const f = await nushiFixture(), first = await published(f);
  let previous = first.id;
  for (let n = 0; n < 2; n++) {
    const reply = await createReply(f.db, "nushi-caller", f.topic, { body: `@nushi orchard followup ${n}`, lang: "en", nushiParentId: previous });
    if (!reply.ok) throw new Error(reply.error);
    const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, reply.id));
    await processNushiRequest(f.db, request.id);
    const [answer] = await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.requestId, request.id)); previous = answer.id;
  }
  await f.db.update(nushiAnswers).set({ hiddenAt: new Date(), hiddenReason: "moderation" }).where(eq(nushiAnswers.id, first.id));
  expect((await f.db.select().from(nushiAnswers)).every(answer => answer.hiddenAt !== null)).toBe(true);
  expect((await f.db.select().from(entries).where(eq(entries.threadId, f.topic))).filter(entry => entry.deletedAt === null)).toHaveLength(2);
});
it("merges citation notices within a UTC day and honors the cited member's opt-out", async () => {
  const f = await nushiFixture(); await published(f);
  const fake = resolveNushiCompleter();
  for (let n = 0; n < 2; n++) {
    if (n === 1) await f.db.update(profiles).set({ nushiCitationNotifications: false }).where(eq(profiles.userId, "nushi-owner"));
    const reply = await createReply(f.db, "nushi-caller", f.topic, { body: `@nushi orchard notice ${n}`, lang: "en" });
    if (!reply.ok) throw new Error(reply.error);
    const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, reply.id));
    await processNushiRequest(f.db, request.id, { completer: { ...fake, async complete(req) {
      const input = JSON.parse(req.user);
      input.materials = input.materials.filter((s: { id: string }) => s.id.startsWith(`e-${f.source}-`));
      return fake.complete({ ...req, user: JSON.stringify(input) });
    } } });
  }
  const rows = await f.db.select().from(notifications).where(eq(notifications.kind, "nushi_cited"));
  expect(rows).toHaveLength(1); expect(rows[0].mergedCount).toBe(2);
});
it("adds quotation context, reply counterarguments and concrete reading details only to Nushi", async () => {
  const f = await nushiFixture();
  const input = await nushiMaterials(f.db, f.request, { env: process.env, now: new Date(), clock: () => new Date() });
  if (!input) throw new Error("Missing Nushi materials");
  const nushi = nushiPrompt(input);
  const post = questionPrompt(input.materials, "What does this post say?", input.language);
  expect(nushi.system).toContain(`Prompt version: ${NUSHI_PROMPT_VERSION}`);
  const rules = [
    /cut a quotation.*conditions, reservations and limitations.*same post/,
    /topic post.*replies.*conditions, objections or opposition.*own author/,
    /dates, numbers, scope and subjects.*reading text.*language differs/,
  ];
  for (const rule of rules) {
    expect(nushi.system).toMatch(rule);
    expect(post.system).not.toMatch(rule);
  }
  expect(nushi.maxOutputTokens).toBe(post.maxOutputTokens);
});
it("shows the limited-range result for a fixed current-belief refusal", async () => {
  const f = await nushiFixture(), fake = resolveNushiCompleter();
  const answer = await published(f, { ...fake, async complete(req) {
    expect(req.system).toContain("CURRENT belief");
    return { text: JSON.stringify({ status: "not_confirmed", readings: [] }), inputTokens: 1, outputTokens: 1 };
  } });
  expect(answer.answer).toEqual({ status: "not_confirmed", readings: [], citations: [], askPerson: false });
});
it("bounds retries without retaining provider text in requests or errors", async () => {
  const f = await nushiFixture(), fake = resolveNushiCompleter();
  const complete = vi.fn(async () => { throw new Error("PROVIDER_PAYLOAD_SHOULD_NOT_BE_SAVED"); });
  for (let n = 0; n < 2; n++) await expect(processNushiRequest(f.db, f.request.id, { completer: { ...fake, complete } })).rejects.toThrow("Nushi is temporarily unavailable");
  await processNushiRequest(f.db, f.request.id, { completer: { ...fake, complete } });
  await processNushiRequest(f.db, f.request.id, { completer: { ...fake, complete } });
  expect(complete).toHaveBeenCalledTimes(3);
  const [request] = await f.db.select().from(nushiRequests);
  expect(request).toMatchObject({ state: "failed", failure: "unavailable", attempts: 3 });
  expect(JSON.stringify(request)).not.toContain("PROVIDER_PAYLOAD");
});

it("counts only published cited authors and keeps other authors available after a cap", async () => {
  const f = await nushiFixture();
  await published(f);
  expect((await f.db.select().from(nushiReservations)).filter(row => row.key.startsWith("author:")).map(row => row.key)).toEqual(["author:nushi-owner"]);
  const other = await createTopic(f.db, "nushi-follower", { body: "The orchard has a separate seasonal source.", lang: "en", village: f.village.slug });
  const topic = await createTopic(f.db, "nushi-owner", { body: "A new orchard discussion.", lang: "en", village: f.village.slug });
  if (!other.ok || !topic.ok) throw new Error("Missing source or topic");
  const call = await createReply(f.db, "nushi-caller", topic.id, { body: "@nushi orchard", lang: "en" });
  if (!call.ok) throw new Error(call.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, call.id));
  const fake = resolveNushiCompleter();
  await processNushiRequest(f.db, request.id, { env: { ...process.env, VILLAGE_NUSHI_AUTHOR_DAILY_LIMIT: "1" }, completer: { ...fake, async complete(req) {
    const input = JSON.parse(req.user);
    expect(input.materials.some((source: { author: string }) => source.author === "@znushi_owner")).toBe(false);
    const source = input.materials.find((source: { id: string }) => source.id === `e-${other.id}-body`);
    expect(source).toBeDefined();
    return { text: JSON.stringify({ status: "answered", readings: [{ text: "A seasonal source.", citations: [{ sourceId: source.id, quote: source.original }] }] }), inputTokens: 1, outputTokens: 1 };
  } } });
  expect((await f.db.select().from(nushiRequests).where(eq(nushiRequests.id, request.id)))[0].state).toBe("answered");
  expect((await f.db.select().from(nushiReservations)).filter(row => row.key.startsWith("author:")).map(row => row.key).sort()).toEqual(["author:nushi-follower", "author:nushi-owner"]);
});
it("does not consume author allowances for a published answer without citations", async () => {
  const f = await nushiFixture(), fake = resolveNushiCompleter();
  await published(f, { ...fake, async complete() { return { text: JSON.stringify({ status: "not_confirmed", readings: [] }), inputTokens: 1, outputTokens: 1 }; } });
  expect((await f.db.select().from(nushiReservations)).filter(row => row.key.startsWith("author:"))).toHaveLength(0);
});
it("excludes exhausted authors before the search limit and keeps the caller's own sources", async () => {
  const f = await nushiFixture();
  const own = await createTopic(f.db, "nushi-caller", { body: "An older orchard source by the caller.", lang: "en", village: f.village.slug });
  const other = await createTopic(f.db, "nushi-follower", { body: "An older orchard source by another writer.", lang: "en", village: f.village.slug });
  if (!own.ok || !other.ok) throw new Error("Missing sources");
  for (let n = 0; n < 21; n++) await createTopic(f.db, "nushi-owner", { body: `A newer orchard source ${n}.`, lang: "en", village: f.village.slug });
  await f.db.insert(nushiReservations).values(["nushi-owner", "nushi-caller"].map(author => ({ requestId: f.request.id, key: `author:${author}`, day: new Date().toISOString().slice(0, 10) })));
  const result = await nushiMaterials(f.db, f.request, { env: { ...process.env, VILLAGE_NUSHI_AUTHOR_DAILY_LIMIT: "1" }, now: new Date(), clock: () => new Date() });
  expect(result?.materials.sources.map(s => s.id)).toEqual(expect.arrayContaining([`e-${own.id}-body`, `e-${other.id}-body`]));
  expect(result?.materials.sources.some(s => s.author === "@znushi_owner")).toBe(false);
  const vector = Array.from({ length: EMBEDDING_DIM }, (_, i) => i === 0 ? 1 : 0);
  const sources = await f.db.select().from(entries);
  await f.db.insert(entryEmbeddings).values(sources.map(entry => ({ entryId: entry.id, model: "quota-test", dim: EMBEDDING_DIM, embedding: vector, sourceHash: entry.sourceHash! })));
  const { findSimilar } = await import("~/lib/search.server");
  const similar = await findSimilar(f.db, vector, "quota-test", 20, f.village.id, ["nushi-owner"]);
  expect(similar.map(s => s.id)).toEqual(expect.arrayContaining([own.id, other.id]));
  expect(similar.some(s => s.authorHandle === "znushi_owner")).toBe(false);
});
it("rejects a known caller limit before the embedding API", async () => {
  const f = await nushiFixture();
  await f.db.insert(nushiReservations).values({ requestId: f.request.id, key: "member:nushi-caller", day: new Date().toISOString().slice(0, 10) });
  const call = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi orchard", lang: "en" });
  if (!call.ok) throw new Error(call.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, call.id));
  const { resolveEmbeddingEngine } = await import("~/lib/llm/config.server");
  const engine = resolveEmbeddingEngine({ EMBEDDING_ENGINE: "fake" });
  const embed = vi.fn(engine.embed.bind(engine));
  await processNushiRequest(f.db, request.id, { env: { ...process.env, VILLAGE_NUSHI_MEMBER_DAILY_LIMIT: "1" }, embedding: { ...engine, embed } });
  expect(embed).not.toHaveBeenCalled();
  expect((await f.db.select().from(nushiRequests).where(eq(nushiRequests.id, request.id)))[0].failure).toBe("limit");
});
it("queues immediate result and citation mail on creation without reviving failed mail", async () => {
  const f = await nushiFixture();
  await f.db.update(profiles).set({ emailPref: "immediate" });
  await published(f);
  const noticeIds = (await f.db.select().from(notifications)).filter(row => row.kind.startsWith("nushi_")).map(row => row.id);
  const sent = await f.db.select().from(jobs).where(eq(jobs.kind, "send_notification_email"));
  expect(sent.map(row => (row.payload as { notificationId: number }).notificationId).sort()).toEqual(noticeIds.sort());
  await f.db.update(jobs).set({ status: "failed" }).where(eq(jobs.kind, "send_notification_email"));
  const reply = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi orchard another", lang: "en" });
  if (!reply.ok) throw new Error(reply.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, reply.id));
  await processNushiRequest(f.db, request.id);
  await expireNushiRequests(f.db);
  const cited = (await f.db.select().from(notifications)).find(row => row.kind === "nushi_cited")!;
  expect(await f.db.select().from(jobs).where(eq(jobs.dedupeKey, `notification-email:${cited.id}`))).toHaveLength(1);
  const select = vi.fn(() => { throw new Error("Disabled Nushi must not poll the database"); });
  await expireNushiRequests({ select } as unknown as Db, new Date(), {});
  expect(select).not.toHaveBeenCalled();
});
it.each(["topic", "village"])("queues durable immediate cancellation mail when a %s is stopped", async stop => {
  const f = await nushiFixture();
  await f.db.update(profiles).set({ emailPref: "immediate" }).where(eq(profiles.userId, "nushi-caller"));
  if (stop === "topic") await setTopicNushi(f.db, "nushi-caller", f.topic, true);
  else await setVillageNushi(f.db, "nushi-owner", f.village.id, false);
  const [notice] = await f.db.select().from(notifications).where(eq(notifications.kind, "nushi_result"));
  const [job] = await f.db.select().from(jobs).where(eq(jobs.kind, "email_nushi_result"));
  expect(job.payload).toEqual({ notificationId: notice.id });
  const { createNushiHandlers } = await import("~/lib/nushi.server");
  const handler = createNushiHandlers().email_nushi_result;
  await handler(job, { db: f.db, now: new Date() });
  await f.db.update(jobs).set({ status: "failed" }).where(eq(jobs.kind, "send_notification_email"));
  await handler(job, { db: f.db, now: new Date() });
  expect(await f.db.select().from(jobs).where(eq(jobs.kind, "send_notification_email"))).toHaveLength(1);
});
it("loads eligible places once for all AI counts", async () => {
  const f = await nushiFixture(); await published(f);
  const reply = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi orchard again", lang: "en" });
  if (!reply.ok) throw new Error(reply.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, reply.id));
  await processNushiRequest(f.db, request.id);
  const { nushiCounts } = await import("~/lib/nushi.server");
  const select = vi.spyOn(f.db, "select");
  expect(await nushiCounts(f.db, [f.topic, f.source])).toEqual(new Map([[f.topic, 2]]));
  expect(select).toHaveBeenCalledTimes(2);
  select.mockRestore();
  await setTopicNushi(f.db, "nushi-caller", f.topic, true);
  expect(await nushiCounts(f.db, [f.topic])).toEqual(new Map());
});
it("exports only the member's source snapshots and anonymizes them on withdrawal", async () => {
  const f = await nushiFixture(), answer = await published(f);
  await reportNushi(f.db, "nushi-follower", { answerId: answer.id, kind: "error", reason: "wrong_post", note: "Review the attribution.", consent: true });
  const [beforeReport] = await f.db.select().from(nushiReports);
  expect(JSON.stringify(beforeReport.evidence)).toContain("@znushi_owner");
  const { buildMemberExport } = await import("~/lib/exports.server");
  const own = await buildMemberExport(f.db, "nushi-owner");
  expect(own.nushi_sources).toEqual([expect.objectContaining({ answer_id: answer.id, entry_id: f.source, author: "@znushi_owner" })]);
  expect(JSON.stringify(own.nushi_sources)).not.toContain("znushi_caller");
  expect((await buildMemberExport(f.db, "nushi-follower")).nushi_sources).toEqual([]);
  const { deleteAccount } = await import("~/lib/account-delete.server");
  await deleteAccount(f.db, "nushi-owner", { confirmation: "znushi_owner", villages: { [f.village.id]: "end" } });
  const rows = await f.db.select().from(nushiSources).where(eq(nushiSources.entryId, f.source));
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ author: "[deleted]", authorId: null });
  const [afterReport] = await f.db.select().from(nushiReports);
  const before = beforeReport.evidence as { materials: Array<{ id: string; author: string }>; answer: { citations: Array<{ sourceId: string; author: string }> } };
  const expected = structuredClone(before);
  for (const material of expected.materials) if (material.id.startsWith(`e-${f.source}-`)) material.author = "[deleted]";
  for (const citation of expected.answer.citations) if (citation.sourceId.startsWith(`e-${f.source}-`)) citation.author = "[deleted]";
  expect(afterReport.evidence).toEqual(expected);
});
