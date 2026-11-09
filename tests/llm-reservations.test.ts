import { afterEach, expect, it, vi } from "vitest";
import { llmUsage, jobs } from "~/lib/db/schema";
import { getBudgetStatus, getMonthlyBreakdown, getMonthlyCostMicro, releaseReservation, reserveUsage, settleReservation } from "~/lib/llm/usage.server";
import { flushUsageSettlements, meteredCall } from "~/lib/llm/metering.server";
import { isDivergenceAvailable, isSecondaryAvailable } from "~/lib/llm/index.server";
import { createFakeEngine, createFakeJudge } from "~/lib/llm/engines/fake.server";
import { createTestDb } from "./helpers/db";

const now = new Date("2026-10-17T00:00:00Z");
const env = { LLM_MONTHLY_BUDGET_USD: "0.0001" };
const request = { engine: "claude", model: "claude-haiku-4-5", purpose: "translate" as const, role: "primary" as const, estimateMicro: 60, now, env };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("atomically admits one of two concurrent reservations that would exceed the cap together", async () => {
  const db = await createTestDb();
  const outcomes = await Promise.allSettled([reserveUsage(db, request), reserveUsage(db, request)]);
  expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(await getMonthlyCostMicro(db, now)).toBe(60);
  const [row] = await db.select().from(llmUsage);
  expect(row).toMatchObject({ reserved: true, costUsdMicro: 60 });
  await settleReservation(db, row.id, { inputTokens: 10, outputTokens: 2, now });
  expect(await getMonthlyCostMicro(db, now)).toBe(20);
  expect((await db.select().from(llmUsage))[0]).toMatchObject({ reserved: false, inputTokens: 10, outputTokens: 2 });
});

it("retries ledger persistence without repeating a successful provider call", async () => {
  const db = await createTestDb();
  const originalUpdate = db.update.bind(db);
  let failSettlement = true;
  const update = vi.spyOn(db, "update").mockImplementation(table => {
    const builder = originalUpdate(table);
    const set = builder.set.bind(builder);
    builder.set = values => {
      if (table === llmUsage && "inputTokens" in values && failSettlement) {
        failSettlement = false;
        throw new Error("ledger unavailable");
      }
      return set(values);
    };
    return builder;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const provider = vi.fn(async () => ({ text: "paid result", inputTokens: 10, outputTokens: 2 }));
  try {
    const result = await meteredCall(db, { ...request, clock: () => now }, provider, r => r);
    expect(result).toMatchObject({ result: { text: "paid result" }, costUsdMicro: 20 });
    expect((await db.select().from(llmUsage))[0]).toMatchObject({ reserved: true, costUsdMicro: 60 });
    await flushUsageSettlements(db);
    expect((await db.select().from(llmUsage))[0]).toMatchObject({ reserved: false, costUsdMicro: 20 });
    expect(provider).toHaveBeenCalledTimes(1);
  } finally { update.mockRestore(); warn.mockRestore(); }
});

it("counts an outstanding reservation across a UTC month boundary", async () => {
  const db = await createTestDb();
  await reserveUsage(db, { ...request, now: new Date("2026-09-30T23:59:59Z") });
  await expect(reserveUsage(db, { ...request, now: new Date("2026-10-01T00:00:01Z") })).rejects.toMatchObject({ name: "BudgetPausedError" });
});

it("removes an uncharged failed call's reservation and keeps chat and public budgets independent", async () => {
  const db = await createTestDb();
  const id = await reserveUsage(db, request);
  await releaseReservation(db, id);
  expect(await db.select().from(llmUsage)).toEqual([]);
  await reserveUsage(db, { ...request, estimateMicro: 100 });
  await expect(reserveUsage(db, { ...request, purpose: "chat", role: "chat", env: { ...env, CHAT_LLM_MONTHLY_BUDGET_USD: "0.0001" } })).resolves.toBeTypeOf("number");
});

const budgets = [
  { purpose: "translate" as const, role: "primary" as const },
  { purpose: "chat" as const, role: "chat" as const },
];
const bothCaps = { ...env, CHAT_LLM_MONTHLY_BUDGET_USD: "0.0001" };

it.each(budgets)("bounds cross-month reservations to ten minutes for $purpose without waiting for maintenance", async ({ purpose, role }) => {
  const db = await createTestDb();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T23:55:00Z"));
  await reserveUsage(db, { ...request, purpose, role, estimateMicro: 100, env: bothCaps, now: new Date() });
  await vi.advanceTimersByTimeAsync(600_000);
  expect(await getMonthlyCostMicro(db, new Date(), [purpose])).toBe(100);
  await vi.advanceTimersByTimeAsync(1);
  expect(await getMonthlyCostMicro(db, new Date(), [purpose])).toBe(0);
  expect(await getMonthlyCostMicro(db, new Date("2026-09-30T23:59:59Z"), [purpose])).toBe(100);
});

it.each(budgets)("finalizes abandoned $purpose estimates on maintenance and accepts a later actual settlement", async ({ purpose, role }) => {
  const db = await createTestDb();
  vi.useFakeTimers();
  const started = new Date("2026-09-30T23:55:00Z");
  vi.setSystemTime(started);
  const id = await reserveUsage(db, { ...request, purpose, role, estimateMicro: 100, env: bothCaps, now: new Date() });
  await vi.advanceTimersByTimeAsync(600_000);
  await flushUsageSettlements(db);
  expect((await db.select().from(llmUsage))[0].reserved).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  await flushUsageSettlements(db);
  expect(await db.select().from(llmUsage)).toMatchObject([{ id, reserved: false, costUsdMicro: 100, createdAt: started }]);
  expect(await getBudgetStatus(db, new Date(), bothCaps, [purpose])).toMatchObject({ state: "normal", usedMicro: 0 });
  expect(await getBudgetStatus(db, started, bothCaps, [purpose])).toMatchObject({ state: "stopped", usedMicro: 100 });
  const next = await reserveUsage(db, { ...request, purpose, role, estimateMicro: 100, env: bothCaps, now: new Date() });
  await releaseReservation(db, next);
  await settleReservation(db, id, { inputTokens: 10, outputTokens: 2, now: new Date() });
  expect(await db.select().from(llmUsage)).toMatchObject([{ id, reserved: false, costUsdMicro: 20, inputTokens: 10, outputTokens: 2, createdAt: new Date() }]);
  expect(await getBudgetStatus(db, new Date(), bothCaps, [purpose])).toMatchObject({ state: "normal", usedMicro: 20 });
  expect((await getMonthlyBreakdown(db, new Date())).map(r => [r.purpose, r.calls, r.costMicro])).toEqual([[purpose, 1, 20]]);
});

it("reports only settled usage while retaining reservations for admission and allowing secondary calls below the settled threshold", async () => {
  const db = await createTestDb();
  await db.insert(llmUsage).values({ engine: request.engine, model: request.model, purpose: request.purpose, costUsdMicro: 20, createdAt: now });
  await reserveUsage(db, request);
  expect(await getBudgetStatus(db, now, env)).toMatchObject({ state: "normal", usedMicro: 20, percent: 20 });
  expect((await getMonthlyBreakdown(db, now)).map(r => [r.calls, r.costMicro])).toEqual([[1, 20]]);
  expect(await getMonthlyCostMicro(db, now)).toBe(80);
  const options = { now, env, engines: { primary: createFakeEngine(), secondary: createFakeEngine(), judge: createFakeJudge() } };
  expect(await isSecondaryAvailable(db, options)).toBe(true);
  expect(await isDivergenceAvailable(db, options)).toBe(true);
  await expect(reserveUsage(db, { ...request, role: "secondary", estimateMicro: 20 })).resolves.toBeTypeOf("number");
  await expect(reserveUsage(db, { ...request, estimateMicro: 1 })).rejects.toMatchObject({ state: "normal", reason: "insufficient" });
});

it.each([0, 80])("distinguishes insufficient reservation capacity from the settled budget state after spending %i", async spent => {
  const db = await createTestDb();
  if (spent) await db.insert(llmUsage).values({ engine: request.engine, model: request.model, purpose: request.purpose, costUsdMicro: spent, createdAt: now });
  const status = await getBudgetStatus(db, now, env);
  await expect(reserveUsage(db, { ...request, estimateMicro: 101 - spent })).rejects.toMatchObject({
    name: "BudgetPausedError", state: status.state, reason: "insufficient", message: expect.stringContaining("insufficient"),
  });
});

it("preserves the provider error and logs a failed reservation release", async () => {
  const db = await createTestDb();
  vi.spyOn(db, "delete").mockImplementationOnce(() => { throw new Error("release unavailable"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const original = new Error("provider unavailable");
  await expect(meteredCall(db, { ...request, clock: () => now }, async () => { throw original; }, () => ({ inputTokens: 0, outputTokens: 0 }))).rejects.toBe(original);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("reservation release failed"), "release unavailable");
  expect(await db.select().from(llmUsage)).toMatchObject([{ reserved: true, costUsdMicro: 60 }]);
});

it("retries pending actual usage after conservative expiration without repeating the provider call", async () => {
  const db = await createTestDb();
  vi.useFakeTimers();
  const finished = new Date("2026-09-30T23:55:00Z");
  vi.setSystemTime(finished);
  const update = db.update.bind(db);
  let unavailable = true;
  vi.spyOn(db, "update").mockImplementation(table => {
    const builder = update(table);
    const set = builder.set.bind(builder);
    builder.set = values => {
      if (table === llmUsage && "inputTokens" in values && unavailable) throw new Error("ledger unavailable");
      return set(values);
    };
    return builder;
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const provider = vi.fn(async () => ({ inputTokens: 10, outputTokens: 2 }));
  await meteredCall(db, { ...request, now: finished, clock: () => new Date() }, provider, r => r);
  await vi.advanceTimersByTimeAsync(600_001);
  await flushUsageSettlements(db);
  expect(await db.select().from(llmUsage)).toMatchObject([{ reserved: false, costUsdMicro: 60, createdAt: finished }]);
  unavailable = false;
  await flushUsageSettlements(db);
  expect(await db.select().from(llmUsage)).toMatchObject([{ reserved: false, costUsdMicro: 20, createdAt: finished }]);
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await getBudgetStatus(db, finished, env)).usedMicro).toBe(20);
  expect((await getBudgetStatus(db, new Date(), env)).usedMicro).toBe(0);
});

it("drops a missing settlement from pending and logs it only once", async () => {
  const db = await createTestDb();
  const usage = await import("~/lib/llm/usage.server");
  const settlement = vi.spyOn(usage, "settleReservation").mockRejectedValueOnce(new Error("temporary write failure"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await meteredCall(db, { ...request, clock: () => now }, async () => ({ inputTokens: 10, outputTokens: 2 }), r => r);
  settlement.mockRestore();
  await db.delete(llmUsage);
  warn.mockClear();
  await flushUsageSettlements(db, now);
  await flushUsageSettlements(db, now);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toMatch(/reservation.*missing/i);
});

it("counts only queued jobs waiting for reservation capacity for the operator", async () => {
  const db = await createTestDb();
  const { BudgetPausedError } = await import("~/lib/llm/errors.server");
  const { enqueue, runDueJobs } = await import("~/lib/jobs/queue.server");
  const now = new Date();
  for (const reason of ["insufficient", "state"] as const) {
    await enqueue(db, "budget_fixture", { reason });
  }
  await runDueJobs(db, { budget_fixture: async job => {
    const error = new BudgetPausedError("normal", new Date(now.getTime() + 60_000), "primary", (job.payload as { reason: "insufficient" | "state" }).reason);
    error.message = "a changed human-readable message";
    throw error;
  } }, { now: new Date(now.getTime() + 1000), logger: { warn() {}, error() {} } });
  expect((await db.select().from(jobs)).some(job => job.lastError?.startsWith("deferred: [llm-budget-reservation-capacity] "))).toBe(true);
  await db.insert(jobs).values([
    { kind: "translate_entry", status: "queued", lastError: "an unrelated error mentioning llm budget normal: insufficient remaining budget for primary" },
    { kind: "translate_entry", status: "failed", lastError: "llm budget normal: insufficient remaining budget for primary" },
    { kind: "translate_entry", status: "queued", lastError: "llm budget stopped: primary disabled" },
  ]);
  const usage = await import("~/lib/llm/usage.server");
  expect(await usage.countBudgetReservationWaits(db)).toBe(1);
});
