import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { EMBEDDING_DIM, entries, entryEmbeddings, jobs, llmUsage } from "~/lib/db/schema";
import { EMBED_JOB, embedDedupeKey, enqueueEmbedding, pruneOtherModels, requeueEmbeddings } from "~/lib/embeddings.server";
import { createEmbeddingHandlers } from "~/lib/jobs/embedding-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createReply, createTopic, editEntry, softDeleteEntry } from "~/lib/entries.server";
import { hideEntry, unhideEntry, type Actor } from "~/lib/moderation.server";
import { budgetResumeAt } from "~/lib/llm/usage.server";
import { resolveEmbeddingEngine } from "~/lib/llm/config.server";
import { createFakeEmbeddingEngine, fakeEmbeddingVector, FAKE_EMBEDDING_MODEL } from "~/lib/llm/engines/fake-embedding.server";
import { clipText, createGeminiEmbeddingEngine, DEFAULT_EMBEDDING_MODEL, EMBED_MAX_CHARS, type GeminiEmbeddingClient } from "~/lib/llm/engines/gemini-embedding.server";
import { BudgetPausedError, embed, isUsableEmbedding } from "~/lib/llm/index.server";
import { costMicro } from "~/lib/llm/pricing.server";
import { LlmError } from "~/lib/llm/errors.server";
import { addMember, createTestDb } from "./helpers/db";

const t0 = new Date("2026-10-05T00:00:00Z");

const cosine = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));

async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  return db;
}

async function newTopic(db: Db, input: { title?: string; body?: string; lang?: string } = {}) {
  const res = await createTopic(db, "u1", { lang: input.lang ?? "ja", title: input.title ?? "題", body: input.body ?? "本文。" });
  if (!res.ok) throw new Error("topic failed");
  return res.id;
}

const embeddingRows = (db: Db, entryId?: number) =>
  db.select({ entryId: entryEmbeddings.entryId, model: entryEmbeddings.model, dim: entryEmbeddings.dim, sourceHash: entryEmbeddings.sourceHash }).from(entryEmbeddings).where(entryId === undefined ? undefined : eq(entryEmbeddings.entryId, entryId));
const embedJobs = (db: Db) => db.select().from(jobs).where(eq(jobs.kind, EMBED_JOB)).orderBy(jobs.id);
const run = (db: Db, opts: { env?: Record<string, string>; now?: Date } = {}) =>
  runDueJobs(db, createEmbeddingHandlers({ llm: { env: opts.env ?? {}, embeddingEngine: createFakeEmbeddingEngine() } }), { now: opts.now ?? t0, logger: quiet, limit: 100 });

describe("the fake embedding", () => {
  it("is deterministic, has 768 dimensions and is normalized, even for an empty text", () => {
    const a = fakeEmbeddingVector("Cooperation between humans and AI");
    expect(a).toHaveLength(EMBEDDING_DIM);
    expect(fakeEmbeddingVector("Cooperation between humans and AI")).toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1, 10);
    const empty = fakeEmbeddingVector("");
    expect(empty).toHaveLength(EMBEDDING_DIM);
    expect(Math.hypot(...empty)).toBeCloseTo(1, 10);
    expect(Number.isNaN(cosine(empty, a))).toBe(false);
  });

  it("puts the same concept close in different languages, and unrelated texts far apart", () => {
    const en = fakeEmbeddingVector("We need cooperation between humans and AI systems.");
    const others: Record<string, string> = {
      ja: "人間とAIシステムの協力が必要だ。",
      fr: "Il faut une coopération entre les humains et les systèmes d'IA.",
      de: "Wir brauchen Zusammenarbeit zwischen Menschen und KI-Systemen.",
      "zh-Hant": "人類與AI系統之間需要合作。",
      "zh-Hans": "人类与AI系统之间需要合作。",
      ko: "인간과 AI 시스템 사이의 협력이 필요하다.",
      th: "เราต้องการความร่วมมือระหว่างมนุษย์กับระบบ AI",
      vi: "Chúng ta cần hợp tác giữa con người và hệ thống AI.",
    };
    const unrelated = fakeEmbeddingVector("The weather in Kyoto was pleasant, so we walked along the river in the afternoon.");
    for (const [lang, text] of Object.entries(others)) {
      const v = fakeEmbeddingVector(text);
      expect(cosine(en, v), lang).toBeGreaterThan(0.4);
      expect(cosine(en, v), lang).toBeGreaterThan(cosine(unrelated, v) + 0.3);
    }
  });

  it("does not match a concept inside another Latin word", () => {
    // "controlled" contains "control" but is another word; "uncontrolled" likewise
    expect(cosine(fakeEmbeddingVector("control"), fakeEmbeddingVector("uncontrolled controlled"))).toBeLessThan(0.3);
  });
});

describe("the Gemini embedding engine", () => {
  const values = (n = EMBEDDING_DIM) => Array.from({ length: n }, (_, i) => (i % 7) + 1);

  it("sends taskType, outputDimensionality and the title, and returns a normalized vector", async () => {
    const embedContent = vi.fn(async () => ({ embeddings: [{ values: values() }] }));
    const engine = createGeminiEmbeddingEngine({ client: { models: { embedContent } } as unknown as GeminiEmbeddingClient });
    expect(engine).toMatchObject({ id: "gemini", model: DEFAULT_EMBEDDING_MODEL, dim: 768 });
    expect(DEFAULT_EMBEDDING_MODEL).toBe("gemini-embedding-001");
    const doc = await engine.embed({ text: "本文", title: "題", task: "document" });
    expect(embedContent).toHaveBeenCalledWith({
      model: "gemini-embedding-001",
      contents: "本文",
      config: expect.objectContaining({ taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 768, title: "題" }),
    });
    expect(Math.hypot(...doc.vector)).toBeCloseTo(1, 10);
    expect(doc.inputTokens).toBeGreaterThan(0);
    // Queries omit a title and use RETRIEVAL_QUERY.
    await engine.embed({ text: "query", title: "ignored", task: "query" });
    const config = (embedContent.mock.calls[1] as unknown as [{ config: Record<string, unknown> }])[0].config;
    expect(config.taskType).toBe("RETRIEVAL_QUERY");
    expect(config).not.toHaveProperty("title");
  });

  it("rejects a response with the wrong number of values (and reports what was billed)", async () => {
    const engine = createGeminiEmbeddingEngine({ client: { models: { embedContent: async () => ({ embeddings: [{ values: values(3072) }] }) } } as unknown as GeminiEmbeddingClient });
    const err = await engine.embed({ text: "x", task: "query" }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: "invalid_output" });
    expect(err.usage.inputTokens).toBeGreaterThan(0);
    const none = createGeminiEmbeddingEngine({ client: { models: { embedContent: async () => ({}) } } as unknown as GeminiEmbeddingClient });
    await expect(none.embed({ text: "x", task: "query" })).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("clips the input by characters, without splitting a surrogate pair", () => {
    expect(clipText("abc", 5)).toBe("abc");
    expect(clipText("abcdef", 3)).toBe("abc");
    expect(clipText("a😀b", 2)).toBe("a");
    expect(clipText("a".repeat(EMBED_MAX_CHARS + 10), EMBED_MAX_CHARS)).toHaveLength(EMBED_MAX_CHARS);
  });

  it("needs a key when it has no client", async () => {
    await expect(createGeminiEmbeddingEngine({}).embed({ text: "x", task: "query" })).rejects.toMatchObject({ code: "config" });
  });
});

describe("choosing the embedding engine", () => {
  it("is fake without a key, gemini with one, and EMBEDDING_ENGINE / EMBEDDING_MODEL override", () => {
    expect(resolveEmbeddingEngine({})).toMatchObject({ id: "fake", model: FAKE_EMBEDDING_MODEL, dim: 768 });
    expect(resolveEmbeddingEngine({ GEMINI_API_KEY: "k" })).toMatchObject({ id: "gemini", model: "gemini-embedding-001" });
    expect(resolveEmbeddingEngine({ GEMINI_API_KEY: "k", EMBEDDING_MODEL: "gemini-embedding-002" })).toMatchObject({ id: "gemini", model: "gemini-embedding-002" });
    expect(resolveEmbeddingEngine({ GEMINI_API_KEY: "k", EMBEDDING_ENGINE: "fake" })).toMatchObject({ id: "fake" });
    expect(() => resolveEmbeddingEngine({ EMBEDDING_ENGINE: "gemini" })).toThrow(/GEMINI_API_KEY/);
    expect(() => resolveEmbeddingEngine({ EMBEDDING_ENGINE: "nope" })).toThrow(/EMBEDDING_ENGINE/);
  });

  it("the price of gemini-embedding-001 is $0.15 per million input tokens (and the fake engine is free)", () => {
    expect(costMicro("gemini", "gemini-embedding-001", 1_000_000, 0, {})).toBe(150_000);
    expect(costMicro("fake", FAKE_EMBEDDING_MODEL, 1_000_000, 0, {})).toBe(0);
  });
});

describe("embed_entry", () => {
  it("is queued on a topic and on a reply (deduplicated per source hash) and stores one row per entry and model", async () => {
    const db = await setup();
    const topicId = await newTopic(db);
    const reply = await createReply(db, "u1", topicId, { lang: "en", body: "reply about cooperation" });
    if (!reply.ok) throw new Error("reply failed");
    const queued = await embedJobs(db);
    expect(queued).toHaveLength(2);
    const [row] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, topicId));
    expect(queued[0]).toMatchObject({ status: "queued", dedupeKey: embedDedupeKey({ entryId: topicId, sourceHash: row.h! }), payload: { entryId: topicId, sourceHash: row.h } });
    expect(await enqueueEmbedding(db, { id: topicId, sourceHash: row.h! })).toBe(false);
    expect(await embedJobs(db)).toHaveLength(2);

    expect(await run(db)).toMatchObject({ ran: 2, done: 2 });
    expect(await embeddingRows(db)).toEqual(
      expect.arrayContaining([
        { entryId: topicId, model: FAKE_EMBEDDING_MODEL, dim: 768, sourceHash: row.h },
        expect.objectContaining({ entryId: reply.id, model: FAKE_EMBEDDING_MODEL }),
      ]),
    );
    // Cost ledger: purpose=embed; fake embeddings are free.
    const usage = await db.select().from(llmUsage);
    expect(usage).toHaveLength(2);
    expect(usage.every((u) => u.purpose === "embed" && u.engine === "fake" && u.costUsdMicro === 0 && u.outputTokens === 0 && u.inputTokens > 0)).toBe(true);
    // Rerunning an already-embedded version makes no call.
    await db.update(jobs).set({ status: "queued" }).where(eq(jobs.kind, EMBED_JOB));
    expect(await run(db)).toMatchObject({ done: 2 });
    expect(await db.select().from(llmUsage)).toHaveLength(2);
  });

  it("re-embeds after an edit (a new source hash) and the row follows the current version", async () => {
    const db = await setup();
    const id = await newTopic(db, { title: "題", body: "協力について" });
    await run(db);
    const [before] = await db.select().from(entryEmbeddings).where(eq(entryEmbeddings.entryId, id));
    const edited = await editEntry(db, "u1", id, { title: "題", body: "制御について" });
    expect(edited).toMatchObject({ ok: true, changed: true });
    expect(await embedJobs(db)).toHaveLength(2);
    await run(db);
    const rows = await db.select().from(entryEmbeddings).where(eq(entryEmbeddings.entryId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceHash).not.toBe(before.sourceHash);
    const [current] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, id));
    expect(rows[0].sourceHash).toBe(current.h);
    expect(cosine(rows[0].embedding, before.embedding)).toBeLessThan(0.5);
  });

  it("an old version's job does nothing once the entry was edited", async () => {
    const db = await setup();
    const id = await newTopic(db, { body: "古い本文" });
    const [first] = await embedJobs(db);
    await editEntry(db, "u1", id, { title: "題", body: "新しい本文" });
    // Run only the old-version job.
    await db.delete(jobs).where(and(eq(jobs.kind, EMBED_JOB), eq(jobs.status, "queued"), eq(jobs.attempts, 0)));
    await db.insert(jobs).values({ kind: EMBED_JOB, payload: first.payload, status: "queued" });
    expect(await run(db)).toMatchObject({ done: 1 });
    expect(await embeddingRows(db)).toEqual([]);
  });

  it("waits (defers, without a failure or an attempt) while the budget is stopped, and embeds when it is raised", async () => {
    const db = await setup();
    const id = await newTopic(db);
    await db.insert(llmUsage).values({ engine: "gemini", model: "x", purpose: "translate", costUsdMicro: 10_000_000, createdAt: t0 });
    const env = { LLM_MONTHLY_BUDGET_USD: "10" };
    const stats = await run(db, { env });
    expect(stats).toMatchObject({ ran: 1, deferred: 1, failed: 0 });
    const [waiting] = await embedJobs(db);
    expect(waiting).toMatchObject({ status: "queued", attempts: 0, runAt: budgetResumeAt(t0) });
    expect(await embeddingRows(db, id)).toEqual([]);
    // No execution while waiting.
    expect(await run(db, { env, now: new Date(t0.getTime() + 60_000) })).toMatchObject({ ran: 0 });
    expect(await run(db, { env: { LLM_MONTHLY_BUDGET_USD: "50" }, now: new Date(t0.getTime() + 16 * 60_000) })).toMatchObject({ ran: 1, done: 1 });
    expect(await embeddingRows(db, id)).toHaveLength(1);
  });

  it("keeps embedding while the budget is degraded (only the secondary engine and the judge stop)", async () => {
    const db = await setup();
    const id = await newTopic(db);
    await db.insert(llmUsage).values({ engine: "gemini", model: "x", purpose: "translate", costUsdMicro: 8_500_000, createdAt: t0 });
    expect(await run(db, { env: { LLM_MONTHLY_BUDGET_USD: "10" } })).toMatchObject({ done: 1, deferred: 0 });
    expect(await embeddingRows(db, id)).toHaveLength(1);
  });

  it("records the cost of a real engine in the ledger (purpose embed) from the estimated input tokens", async () => {
    const db = await setup();
    const embedContent = vi.fn(async () => ({ embeddings: [{ values: Array.from({ length: EMBEDDING_DIM }, (_, i) => i + 1) }] }));
    const engine = createGeminiEmbeddingEngine({ client: { models: { embedContent } } as unknown as GeminiEmbeddingClient });
    const out = await embed(db, { text: "x".repeat(2000), task: "query" }, { now: t0, env: {}, embeddingEngine: engine });
    expect(out.costUsdMicro).toBe(Math.ceil((1000 * 150) / 1000));
    const [row] = await db.select().from(llmUsage);
    expect(row).toMatchObject({ engine: "gemini", model: "gemini-embedding-001", purpose: "embed", inputTokens: 1000, outputTokens: 0, costUsdMicro: 150 });
  });

  it("throws BudgetPausedError from embed() when stopped (the search shows 'temporarily unavailable')", async () => {
    const db = await setup();
    await db.insert(llmUsage).values({ engine: "gemini", model: "x", purpose: "translate", costUsdMicro: 10_000_000, createdAt: t0 });
    const err = await embed(db, { text: "q", task: "query" }, { now: t0, env: { LLM_MONTHLY_BUDGET_USD: "10" }, embeddingEngine: createFakeEmbeddingEngine() }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetPausedError);
    expect(err).toMatchObject({ state: "stopped", role: "embed" });
  });
});

describe("an unusable embedding (all zeros or not finite)", () => {
  const engineReturning = (vector: number[]) => ({
    id: "fake" as const,
    model: "fake-embedding-1",
    dim: 768,
    async embed() {
      return { vector, model: "fake-embedding-1", inputTokens: 7 };
    },
  });
  const zeros = () => new Array<number>(EMBEDDING_DIM).fill(0);

  it("is rejected by the Gemini engine and by embed() as invalid_output, and the billed input is still recorded", async () => {
    expect(isUsableEmbedding(fakeEmbeddingVector("x"))).toBe(true);
    expect(isUsableEmbedding(zeros())).toBe(false);
    expect(isUsableEmbedding([...zeros().slice(1), Number.NaN])).toBe(false);
    expect(isUsableEmbedding([...zeros().slice(1), Number.POSITIVE_INFINITY])).toBe(false);
    const gemini = createGeminiEmbeddingEngine({ client: { models: { embedContent: async () => ({ embeddings: [{ values: zeros() }] }) } } as unknown as GeminiEmbeddingClient });
    await expect(gemini.embed({ text: "x", task: "query" })).rejects.toMatchObject({ code: "invalid_output" });
    const db = await setup();
    const err = await embed(db, { text: "x", task: "document" }, { now: t0, env: {}, embeddingEngine: engineReturning(zeros()) }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: "invalid_output" });
    // Record incurred charges in the ledger.
    expect(await db.select().from(llmUsage)).toMatchObject([{ purpose: "embed", inputTokens: 7 }]);
  });

  it("is not saved by embed_entry: the job retries instead of storing a vector the index cannot use", async () => {
    const db = await setup();
    const id = await newTopic(db);
    const stats = await runDueJobs(db, createEmbeddingHandlers({ llm: { env: {}, embeddingEngine: engineReturning(zeros()) } }), { now: t0, logger: quiet, limit: 100 });
    expect(stats).toMatchObject({ ran: 1, retried: 1, done: 0 });
    expect(await embeddingRows(db, id)).toEqual([]);
    const [job] = await embedJobs(db);
    expect(job.lastError).toMatch(/invalid_output|LlmError/);
  });
});

describe("hidden and deleted entries", () => {
  const moderator: Actor = { id: "mod", scope: { operator: true, langs: [] } };

  it("are not embedded, their embeddings are removed, and unhide / restore embeds again", async () => {
    const db = await setup();
    await addMember(db, "mod", "moriko");
    const id = await newTopic(db);
    await run(db);
    expect(await embeddingRows(db, id)).toHaveLength(1);
    // Hiding deletes the row; still-queued jobs do nothing.
    const hidden = await hideEntry(db, moderator, { entryId: id, reason: "spam", note: "n" });
    expect(hidden.ok).toBe(true);
    expect(await embeddingRows(db, id)).toEqual([]);
    await db.update(jobs).set({ status: "queued" }).where(eq(jobs.kind, EMBED_JOB));
    await run(db);
    expect(await embeddingRows(db, id)).toEqual([]);
    // Editing while hidden does not embed.
    await db.delete(jobs);
    await editEntry(db, "u1", id, { title: "題", body: "編集した本文" });
    expect(await embedJobs(db)).toEqual([]);
    // Unhiding re-embeds through the same job.
    await unhideEntry(db, moderator, { entryId: id, reason: "other" });
    expect(await embedJobs(db)).toHaveLength(1);
    await run(db);
    expect(await embeddingRows(db, id)).toHaveLength(1);
  });

  it("deleting removes the embeddings and cancels the queued embed job", async () => {
    const db = await setup();
    const id = await newTopic(db);
    const other = await newTopic(db, { title: "別" });
    expect(await embedJobs(db)).toHaveLength(2);
    await softDeleteEntry(db, id);
    expect((await embedJobs(db)).map((j) => (j.payload as { entryId: number }).entryId)).toEqual([other]);
    await run(db);
    expect((await embeddingRows(db)).map((r) => r.entryId)).toEqual([other]);
    // Delete an already-embedded post.
    await softDeleteEntry(db, other);
    expect(await embeddingRows(db)).toEqual([]);
  });
});

describe("requeueEmbeddings (pnpm embeddings:backfill)", () => {
  it("queues the entries without a current embedding for the model, skips hidden and deleted ones, and does not duplicate", async () => {
    const db = await setup();
    const a = await newTopic(db, { title: "a" });
    const b = await newTopic(db, { title: "b" });
    const gone = await newTopic(db, { title: "gone" });
    const hiddenOne = await newTopic(db, { title: "hidden" });
    await db.delete(jobs);
    await softDeleteEntry(db, gone);
    await db.update(entries).set({ hiddenAt: t0 }).where(eq(entries.id, hiddenOne));
    await db.insert(entryEmbeddings).values({ entryId: a, model: FAKE_EMBEDDING_MODEL, dim: 768, embedding: fakeEmbeddingVector("a"), sourceHash: (await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, a)))[0].h! });
    const result = await requeueEmbeddings(db, FAKE_EMBEDDING_MODEL);
    expect(result).toEqual({ entries: 2, queued: 1 });
    expect((await embedJobs(db)).map((j) => (j.payload as { entryId: number }).entryId)).toEqual([b]);
    expect(await requeueEmbeddings(db, FAKE_EMBEDDING_MODEL)).toMatchObject({ queued: 0 });
    // For another model, a is missing too.
    expect(await requeueEmbeddings(db, "gemini-embedding-001")).toMatchObject({ queued: 1 });
    // Count old-version rows as missing, but deduplicate already-queued jobs.
    await db.delete(jobs);
    await db.update(entryEmbeddings).set({ sourceHash: "old" }).where(eq(entryEmbeddings.entryId, a));
    expect(await requeueEmbeddings(db, FAKE_EMBEDDING_MODEL)).toMatchObject({ queued: 2 });
    expect((await embedJobs(db)).map((j) => (j.payload as { entryId: number }).entryId).sort()).toEqual([a, b].sort());
  });
});

describe("pruneOtherModels (pnpm embeddings:backfill --prune-other-models)", () => {
  it("deletes the rows of other models and keeps the current model's rows", async () => {
    const db = await setup();
    const a = await newTopic(db, { title: "a" });
    const b = await newTopic(db, { title: "b" });
    for (const [id, model] of [[a, FAKE_EMBEDDING_MODEL], [a, "old-model"], [b, "old-model"], [b, "older-model"]] as const) {
      await db.insert(entryEmbeddings).values({ entryId: id, model, dim: 768, embedding: fakeEmbeddingVector(model), sourceHash: "h" });
    }
    expect(await pruneOtherModels(db, FAKE_EMBEDDING_MODEL)).toBe(3);
    expect(await embeddingRows(db)).toEqual([{ entryId: a, model: FAKE_EMBEDDING_MODEL, dim: 768, sourceHash: "h" }]);
    expect(await pruneOtherModels(db, FAKE_EMBEDDING_MODEL)).toBe(0);
  });
});
