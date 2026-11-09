import { afterEach, expect, it, vi } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { llmUsage } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { getTranslationWaits, readPostTranslationWait, readTranslationWaits, resetTranslationWaitCache, smallestEstimate, translationWaitFor } from "~/lib/translation-wait.server";
import { BudgetPausedError } from "~/lib/llm/errors.server";
import { reserveUsage } from "~/lib/llm/usage.server";
import { getBudgetStatus } from "~/lib/llm/usage.server";
import { parseThreadBlocks } from "./helpers/md";
import { LANGS } from "~/lib/languages";
import { translationEstimate } from "~/lib/llm/metering.server";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); resetTranslationWaitCache(); });

const at = (y: number, month: number, day: number) => new Date(Date.UTC(y, month - 1, day, 12));
const spend = (db: Awaited<ReturnType<typeof createTestDb>>, micro: number, purpose: "translate" | "chat", when: Date) =>
  db.insert(llmUsage).values({ engine: "claude", model: "claude-haiku-4-5", purpose, costUsdMicro: micro, createdAt: when });

it("reads normal and stopped (used up, or zero) from the monthly budget", async () => {
  const db = await createTestDb();
  const env = { LLM_MONTHLY_BUDGET_USD: "10", CHAT_LLM_MONTHLY_BUDGET_USD: "2" };
  const now = at(2026, 10, 15);
  expect((await getTranslationWaits(db, now, env)).posts).toEqual({ kind: "normal" });
  // Degraded (80% and over) still translates the primary language, so it is not a pause.
  await spend(db, 8_500_000, "translate", now);
  expect((await getTranslationWaits(db, now, env)).posts).toEqual({ kind: "normal" });
  await spend(db, 1_500_000, "translate", now);
  expect((await getTranslationWaits(db, now, env)).posts).toEqual({ kind: "stopped" });
  // The next UTC month has its own ledger: the same spending no longer pauses it.
  expect((await getTranslationWaits(db, at(2026, 11, 1), env)).posts).toEqual({ kind: "normal" });
  // A zero budget is stopped too: a reader is told the same thing either way.
  expect((await getTranslationWaits(db, now, { ...env, LLM_MONTHLY_BUDGET_USD: "0" })).posts).toEqual({ kind: "stopped" });
});

it("keeps the post budget and the chat budget apart, and the UTC month decides when the ledger starts again", async () => {
  const db = await createTestDb();
  vi.stubEnv("VILLAGES", "1");
  vi.stubEnv("VILLAGE_CHAT", "1");
  const env = { ...process.env, VILLAGES: "1", VILLAGE_CHAT: "1", LLM_MONTHLY_BUDGET_USD: "10", CHAT_LLM_MONTHLY_BUDGET_USD: "2" };
  const december = at(2026, 12, 31);
  await spend(db, 2_000_000, "chat", december);
  expect(await getTranslationWaits(db, december, env)).toEqual({ posts: { kind: "normal" }, chat: { kind: "stopped" } });
  await spend(db, 10_000_000, "translate", december);
  expect((await getTranslationWaits(db, december, env)).posts).toEqual({ kind: "stopped" });
  // Just before and just after the UTC boundary.
  const last = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
  expect((await getTranslationWaits(db, last, env)).chat).toEqual({ kind: "stopped" });
  expect((await getTranslationWaits(db, new Date(Date.UTC(2027, 0, 1)), env)).chat).toEqual({ kind: "normal" });
  const status = await getBudgetStatus(db, december, env);
  expect(translationWaitFor(status)).toEqual({ kind: "stopped" });
});

it("does not read the chat ledger while chat is closed, and falls back to normal when the ledger cannot be read", async () => {
  const db = await createTestDb();
  const now = at(2026, 10, 15);
  await spend(db, 5_000_000, "chat", now);
  expect((await getTranslationWaits(db, now, { VILLAGES: "1", CHAT_LLM_MONTHLY_BUDGET_USD: "1" })).chat).toEqual({ kind: "normal" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await readTranslationWaits(async () => { throw new Error("db down"); })).toEqual({ posts: { kind: "normal" }, chat: { kind: "normal" } });
});

it("says in the Markdown twin that translating is stopped, in one general word and without a date", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(2026, 10, 15));
  const now = new Date();
  const db = await createTestDb(); await addMember(db, "waiter", "waiter");
  const made = await createTopic(db, "waiter", { lang: "ja", body: "元の本文。" });
  if (!made.ok) throw new Error(made.error);
  const post = async () => parseThreadBlocks((await buildThreadMarkdown(db, made.id, { page: 1, lang: "all", sentences: false, k: null, readerId: "waiter" }))!).find(b => b.fm.type === "post")!.fm;
  const waiting = await post();
  expect(waiting.translations_pending).toContain("en");
  expect(waiting).not.toHaveProperty("translations_pending_reason");
  expect(waiting).not.toHaveProperty("translations_resume");

  await spend(db, 30_000_000, "translate", now);
  resetTranslationWaitCache();
  const paused = await post();
  expect(paused).toMatchObject({ translations_pending_reason: "unavailable" });
  expect(paused).not.toHaveProperty("translations_resume");
  expect(paused.translations_pending).toContain("en");

  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
  resetTranslationWaitCache();
  const off = await post();
  expect(off).toMatchObject({ translations_pending_reason: "unavailable" });
  expect(off).not.toHaveProperty("translations_resume");
});

// The engine the site really uses (a paid one): the smallest call has a cost, so the remaining amount can be judged against it.
const paid = { TRANSLATION_PRIMARY: "gemini", GEMINI_API_KEY: "test-key", TRANSLATION_GEMINI_MODEL: "gemini-3.8-flash", CHAT_TRANSLATION_MODEL: "gemini-3.8-flash", VILLAGES: "1", VILLAGE_CHAT: "1" };

it("calls the budget paused when the reservation would refuse every job, before the settled spending reaches it", async () => {
  const db = await createTestDb();
  const now = at(2026, 10, 15);
  const env = { ...paid, LLM_MONTHLY_BUDGET_USD: "1", CHAT_LLM_MONTHLY_BUDGET_USD: "1" };
  const smallest = smallestEstimate("posts", env);
  expect(smallest).toBeGreaterThan(100_000);
  const reserve = (estimateMicro: number, purpose: "translate" | "chat" = "translate") =>
    reserveUsage(db, { engine: "gemini", model: "gemini-3.8-flash", purpose, role: purpose === "chat" ? "chat" : "primary", estimateMicro, now, env });

  // Room for the smallest job and for a big one: just waiting.
  expect((await getTranslationWaits(db, now, env)).posts).toEqual({ kind: "normal" });
  // Room for a small job but not a big one: the big one is refused, the state stays "normal" (a middle state, only waiting).
  await spend(db, 1_000_000 - smallest - 10, "translate", now);
  await expect(reserve(smallest * 3)).rejects.toMatchObject({ reason: "insufficient" });
  expect((await getTranslationWaits(db, now, env)).posts).toEqual({ kind: "normal" });
  // What is left cannot cover even the smallest job: every job is refused as insufficient, though the settled spending is below the budget.
  await spend(db, 20, "translate", now);
  const refused = await reserve(smallest).catch(error => error);
  expect(refused).toBeInstanceOf(BudgetPausedError);
  expect(refused.reason).toBe("insufficient");
  expect((await getTranslationWaits(db, now, env)).posts).toEqual({ kind: "stopped" });
  // The next month starts with a clean ledger.
  expect((await getTranslationWaits(db, at(2026, 11, 1), env)).posts).toEqual({ kind: "normal" });

  // Chat has its own ledger and the same rule.
  expect((await getTranslationWaits(db, now, env)).chat).toEqual({ kind: "normal" });
  const chatSmallest = smallestEstimate("chat", env);
  await spend(db, 1_000_000 - chatSmallest + 1, "chat", now);
  const chatRefused = await reserve(chatSmallest, "chat").catch(error => error);
  expect(chatRefused).toBeInstanceOf(BudgetPausedError);
  expect((await getTranslationWaits(db, now, env)).chat).toEqual({ kind: "stopped" });
});

it("does not read the remaining amount when the estimate cannot be worked out", () => {
  expect(smallestEstimate("chat", { TRANSLATION_PRIMARY: "gemini" })).toBe(0);
  expect(smallestEstimate("posts", { TRANSLATION_PRIMARY: "fake" })).toBe(0);
});

it("never declares a stop while a shorter language-specific request can still fit", async () => {
  const db = await createTestDb();
  const now = at(2026, 10, 15);
  const env = { ...paid, LLM_MONTHLY_BUDGET_USD: "1" };
  const costs = LANGS.flatMap(from => LANGS.filter(to => to !== from).map(to =>
    translationEstimate("gemini", "gemini-3.8-flash", { text: "x", from, to, field: "title" }, env)));
  const minimum = Math.min(...costs);
  expect(smallestEstimate("posts", env)).toBeLessThanOrEqual(minimum);
  await spend(db, 1_000_000 - minimum, "translate", now);
  expect((await getTranslationWaits(db, now, env)).posts).toEqual({ kind: "normal" });
});

it("shares concurrent ledger reads, including after expiry, without sharing budgets or database instances", async () => {
  const db = await createTestDb();
  const other = await createTestDb();
  vi.stubEnv("VILLAGES", "1");
  vi.stubEnv("VILLAGE_CHAT", "1");
  const reads = vi.spyOn(db, "select");
  const otherReads = vi.spyOn(other, "select");
  const start = at(2026, 10, 15);
  const batch = (now: Date) => Promise.all(Array.from({ length: 8 }, () => readTranslationWaits(async () => db, now)));
  await batch(start);
  expect(reads).toHaveBeenCalledTimes(2);
  await batch(new Date(start.getTime() + 59_000));
  expect(reads).toHaveBeenCalledTimes(2);
  await batch(new Date(start.getTime() + 61_000));
  expect(reads).toHaveBeenCalledTimes(4);
  await readPostTranslationWait(async () => other, start);
  expect(otherReads).toHaveBeenCalledTimes(1);
});

it("retries after a shared failed ledger read instead of caching the fallback", async () => {
  const db = await createTestDb();
  const now = at(2026, 10, 15);
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reads = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("ledger down"); });
  const results = await Promise.all(Array.from({ length: 4 }, () => readPostTranslationWait(async () => db, now)));
  expect(results).toEqual(Array.from({ length: 4 }, () => ({ kind: "normal" })));
  expect(reads).toHaveBeenCalledTimes(1);
  expect(await readPostTranslationWait(async () => db, now)).toEqual({ kind: "stopped" });
  expect(reads).toHaveBeenCalledTimes(2);
});

it("remembers each budget for a minute, never past the month's end, and does not remember a failed read", async () => {
  const db = await createTestDb();
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "10");
  const get = async () => db;
  const start = at(2026, 10, 15);
  expect((await readTranslationWaits(get, start)).posts).toEqual({ kind: "normal" });
  await spend(db, 10_000_000, "translate", start);
  // Still the remembered state within the minute; read again after it.
  expect((await readTranslationWaits(get, new Date(start.getTime() + 59_000))).posts).toEqual({ kind: "normal" });
  expect((await readTranslationWaits(get, new Date(start.getTime() + 61_000))).posts).toEqual({ kind: "stopped" });

  // The memory ends with the month: a read 30 seconds before it is not reused 40 seconds later.
  resetTranslationWaitCache();
  await db.delete(llmUsage);
  const lastMinute = new Date(Date.UTC(2026, 9, 31, 23, 59, 40));
  expect((await readPostTranslationWait(get, lastMinute))).toEqual({ kind: "normal" });
  await spend(db, 10_000_000, "translate", new Date(Date.UTC(2026, 10, 1, 0, 0, 10)));
  expect((await readPostTranslationWait(get, new Date(Date.UTC(2026, 10, 1, 0, 0, 20))))).toEqual({ kind: "stopped" });

  // A failed read is not remembered: the next request reads again.
  resetTranslationWaitCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await readPostTranslationWait(async () => { throw new Error("db down"); }, start)).toEqual({ kind: "normal" });
  expect(await readPostTranslationWait(get, start)).toEqual({ kind: "normal" });
});
