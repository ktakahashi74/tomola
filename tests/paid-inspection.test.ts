import { afterEach, expect, it, vi } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { chatMessages, chatMessageTranslations, entries, jobs, llmUsage, translations, villages } from "~/lib/db/schema";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { translate, type TranslationOutcome, type TranslationEngine } from "~/lib/llm/index.server";
import * as markdown from "~/lib/markdown-budget.server";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each([1, 2])("resumes inspection after paid call %i without repeating either provider call", async busyAt => {
  const db = await createTestDb();
  let calls = 0;
  const translateCall = vi.fn(async () => ({ text: busyAt === 2 && ++calls === 1 ? "bad" : "翻訳結果", model: "claude-haiku-4-5", promptVersion: "fixture", inputTokens: 10, outputTokens: 2 }));
  const engine: TranslationEngine = { id: "claude", model: "claude-haiku-4-5", translate: translateCall };
  let blocked = false;
  vi.spyOn(markdown, "markdownTask").mockImplementation((async (_operation: string, args: unknown[]) => {
    if (args[1] === "bad") return { flags: ["structure_mismatch"], notes: ["Preserve the structure"] };
    if (!blocked) { blocked = true; throw new markdown.MarkdownBusyError(); }
    return { flags: [], notes: [] };
  }) as typeof markdown.markdownTask);
  let result: TranslationOutcome | undefined;
  const now = new Date("2026-10-17T00:00:00Z");
  const handlers = { paid_fixture: async () => { result = await translate(db, "primary", { text: "A clear original.", from: "en", to: "ja" }, { engines: { primary: engine, secondary: null, judge: null }, now }); } };
  await enqueue(db, "paid_fixture", { retained: "original payload" }, { runAt: now });
  expect(await runDueJobs(db, handlers, { now, limit: 1, logger: { warn() {}, error() {} } })).toMatchObject({ retried: 1 });
  expect(translateCall).toHaveBeenCalledTimes(busyAt);
  const [stored] = await db.select().from(jobs);
  expect(stored.payload).toMatchObject({ retained: "original payload", paidTranslationCalls: expect.any(Object) });
  expect(await runDueJobs(db, handlers, { now: new Date(now.getTime() + 31_000), limit: 1, logger: { warn() {}, error() {} } })).toMatchObject({ done: 1 });
  expect(translateCall).toHaveBeenCalledTimes(busyAt);
  expect(await db.select().from(llmUsage)).toHaveLength(busyAt);
  expect(result).toMatchObject({ text: "翻訳結果", attempts: busyAt, inputTokens: busyAt * 10, costUsdMicro: expect.any(Number) });
  expect(result!.costUsdMicro).toBeGreaterThan(0);
  expect((await db.select().from(jobs))[0].payload).toEqual({ retained: "original payload" });
});

it("resumes a paid fallback without calling the refused primary again", async () => {
  const { createTranslationHandlers } = await import("~/lib/jobs/translation-jobs.server");
  const { LlmError } = await import("~/lib/llm/errors.server");
  const db = await createTestDb();
  await addMember(db, "author", "author");
  const [entry] = await db.insert(entries).values({ authorId: "author", kind: "topic", body: "A clear original.", lang: "en", sourceHash: "h" }).returning();
  const primaryCall = vi.fn(async () => { throw new LlmError("refusal", "refused", { inputTokens: 10, outputTokens: 2 }); });
  const secondaryCall = vi.fn(async () => ({ text: "翻訳結果", model: "claude-haiku-4-5", promptVersion: "fixture", inputTokens: 10, outputTokens: 2 }));
  const primary: TranslationEngine = { id: "claude", model: "claude-haiku-4-5", translate: primaryCall };
  const secondary: TranslationEngine = { id: "claude", model: "claude-haiku-4-5", translate: secondaryCall };
  const task = markdown.markdownTask;
  let blocked = false;
  vi.spyOn(markdown, "markdownTask").mockImplementation((async (operation: string, args: unknown[]) => {
    if (operation !== "inspectTranslation") return task(operation, args);
    if (!blocked) { blocked = true; throw new markdown.MarkdownBusyError(); }
    return { flags: [], notes: [] };
  }) as typeof markdown.markdownTask);
  const now = new Date("2026-10-17T00:00:00Z");
  const handlers = createTranslationHandlers({ llm: { engines: { primary, secondary, judge: null }, now } });
  await enqueue(db, "translate_entry", { entryId: entry.id, lang: "ja", sourceHash: "h" }, { runAt: now });
  expect(await runDueJobs(db, handlers, { now, limit: 1, logger: { warn() {}, error() {} } })).toMatchObject({ retried: 1 });
  expect(await runDueJobs(db, handlers, { now: new Date(now.getTime() + 31_000), limit: 1, logger: { warn() {}, error() {} } })).toMatchObject({ done: 1 });
  expect(primaryCall).toHaveBeenCalledTimes(1);
  expect(secondaryCall).toHaveBeenCalledTimes(1);
  expect(await db.select().from(llmUsage)).toHaveLength(2);
  expect(await db.select().from(translations)).toMatchObject([{ text: "翻訳結果", fallback: true }]);
});

it("resumes actual chat inspection with its strict handler payload and clears the checkpoint", async () => {
  const { createChatTranslationHandlers } = await import("~/lib/jobs/chat-translation-jobs.server");
  const { chatSourceHash } = await import("~/lib/village-chat-translations.server");
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await createTestDb();
  await addMember(db, "author", "author");
  const [village] = await db.insert(villages).values({ kind: "open", slug: "paid-chat" }).returning();
  const [message] = await db.insert(chatMessages).values({ villageId: village.id, authorId: "author", lang: "ja", body: "こんにちは。", createdSeq: 1, changedSeq: 1 }).returning();
  const translateCall = vi.fn(async () => ({ text: "Hello there.", model: "claude-haiku-4-5", promptVersion: "fixture", inputTokens: 10, outputTokens: 2 }));
  const engine: TranslationEngine = { id: "claude", model: "claude-haiku-4-5", translate: translateCall };
  let blocked = false;
  vi.spyOn(markdown, "markdownTask").mockImplementation((async () => {
    if (!blocked) { blocked = true; throw new markdown.MarkdownBusyError(); }
    return { flags: [], notes: [] };
  }) as typeof markdown.markdownTask);
  const now = new Date();
  const handlers = createChatTranslationHandlers({ engines: { primary: engine, secondary: null, judge: null, chat: engine }, now });
  await enqueue(db, "translate_chat", { messageId: message.id, lang: "en", sourceHash: chatSourceHash(message.body) }, { runAt: now });
  expect(await runDueJobs(db, handlers, { now, logger: { warn() {}, error() {} } })).toMatchObject({ retried: 1 });
  expect(await runDueJobs(db, handlers, { now: new Date(now.getTime() + 31_000), logger: { warn() {}, error() {} } })).toMatchObject({ done: 1 });
  expect(await db.select().from(chatMessageTranslations)).toMatchObject([{ state: "ready", text: "Hello there." }]);
  expect(translateCall).toHaveBeenCalledTimes(1);
  expect(await db.select().from(llmUsage)).toHaveLength(1);
  expect((await db.select().from(jobs))[0].payload).not.toHaveProperty("paidTranslationCalls");
});
