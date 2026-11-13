import { and, count, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { llmUsage, jobs } from "~/lib/db/schema";
import { costMicro } from "./pricing.server";
import type { BudgetState, EngineId, LlmEnv } from "./types";
import { BudgetPausedError } from "./errors.server";
import { nushiMonthlyBudgetMicro } from "../nushi-config.server";
import { postAskMonthlyBudgetMicro } from "../ai-question-config.server";
import { budgetReservationWaitCondition } from "../jobs/budget-wait.server";

export type { BudgetState };

// Cost ledger and monthly budget, using UTC month boundaries.

export type UsagePurpose = "translate" | "retry" | "judge" | "embed" | "chat" | "moderation" | "ask" | "ask_village";
export const PUBLIC_USAGE_PURPOSES: readonly UsagePurpose[] = ["translate", "retry", "judge", "embed", "moderation"];
export const CHAT_USAGE_PURPOSES: readonly UsagePurpose[] = ["chat"];
export const NUSHI_USAGE_PURPOSES: readonly UsagePurpose[] = ["ask_village"];
export const POST_ASK_USAGE_PURPOSES: readonly UsagePurpose[] = ["ask"];

export function chatMonthlyBudgetMicro(env: LlmEnv = process.env): number {
  const raw = env.CHAT_LLM_MONTHLY_BUDGET_USD?.trim() || "2";
  const usd = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(usd) || !Number.isSafeInteger(Math.round(usd * 1_000_000))) throw new Error("CHAT_LLM_MONTHLY_BUDGET_USD must be a non-negative finite number");
  return Math.round(usd * 1_000_000);
}

export const DEFAULT_MONTHLY_BUDGET_USD = 20;
// Budget thresholds: degraded at 80%, stopped at 100%.
export const DEGRADED_PERCENT = 80;

// Record one call's usage and return microdollar cost.
export async function recordUsage(
  db: Db,
  u: { engine: EngineId | string; model: string; purpose: UsagePurpose; inputTokens: number; outputTokens: number; now?: Date; env?: LlmEnv },
): Promise<number> {
  const cost = costMicro(u.engine, u.model, u.inputTokens, u.outputTokens, u.env);
  await db.insert(llmUsage).values({
    engine: u.engine,
    model: u.model,
    purpose: u.purpose,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    costUsdMicro: cost,
    createdAt: u.now,
  });
  return cost;
}

// UTC month containing now, range [start,end).
export function monthRangeUtc(now: Date): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

const warned = new Set<string>();

// Monthly microdollar cap: LLM_MONTHLY_BUDGET_USD, default 20. Invalid or negative values warn and use default. 0 disables LLM usage, always stopped.
export function monthlyBudgetMicro(env: LlmEnv = process.env): number {
  const raw = env.LLM_MONTHLY_BUDGET_USD?.trim();
  if (raw) {
    const usd = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isFinite(usd) && Number.isSafeInteger(Math.round(usd * 1_000_000))) return Math.round(usd * 1_000_000);
    if (env.NODE_ENV === "production") throw new Error("LLM_MONTHLY_BUDGET_USD must be a non-negative finite number within the safe integer range in microdollars");
    if (!warned.has(raw)) {
      warned.add(raw);
      console.warn(`[llm] LLM_MONTHLY_BUDGET_USD must be a non-negative number; using ${DEFAULT_MONTHLY_BUDGET_USD} instead of "${raw}"`);
    }
  }
  return DEFAULT_MONTHLY_BUDGET_USD * 1_000_000;
}

// normal below 80%; degraded from 80% to below 100% (secondary/judge stop); stopped at 100% or above (primary also stops).
export function budgetStateFor(usedMicro: number, budgetMicro: number): BudgetState {
  if (usedMicro >= budgetMicro) return "stopped";
  if (usedMicro * 100 >= budgetMicro * DEGRADED_PERCENT) return "degraded";
  return "normal";
}

// Admission includes this month's reservations and recent calls crossing midnight.
export const RESERVATION_TTL_MS = 10 * 60 * 1000;
export async function getMonthlyCostMicro(db: Db, now: Date = new Date(), purposes: readonly UsagePurpose[] = PUBLIC_USAGE_PURPOSES): Promise<number> {
  return monthlyCostMicro(db, now, purposes, "include");
}

async function monthlyCostMicro(db: Db, now: Date, purposes: readonly UsagePurpose[], reservations: "include" | "exclude"): Promise<number> {
  const { start, end } = monthRangeUtc(now);
  const inMonth = and(gte(llmUsage.createdAt, start), lt(llmUsage.createdAt, end));
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${llmUsage.costUsdMicro}), 0)` })
    .from(llmUsage)
    .where(and(
      reservations === "include"
        ? or(inMonth, and(eq(llmUsage.reserved, true), gte(llmUsage.createdAt, new Date(now.getTime() - RESERVATION_TTL_MS))))
        : and(inMonth, eq(llmUsage.reserved, false)),
      inArray(llmUsage.purpose, [...purposes]),
    ));
  return Number(row.total);
}

// Unknown outcomes become conservative charges in their creation month. Keep the
// row so a late actual settlement can still replace its estimate idempotently.
export async function finalizeExpiredReservations(db: Db, now = new Date()): Promise<void> {
  await db.update(llmUsage).set({ reserved: false })
    .where(and(eq(llmUsage.reserved, true), lt(llmUsage.createdAt, new Date(now.getTime() - RESERVATION_TTL_MS))));
}

type ReservationRequest = {
  engine: string;
  model: string;
  purpose: UsagePurpose;
  role: "primary" | "secondary" | "retry" | "judge" | "embed" | "chat" | "ask";
  estimateMicro: number;
  now: Date;
  env?: LlmEnv;
};

// The lock covers only ledger admission, never the network call. Table locking also
// serializes direct ledger writers and works with both PostgreSQL and PGlite.
export async function reserveUsage(db: Db, req: ReservationRequest): Promise<number> {
  if (!Number.isSafeInteger(req.estimateMicro) || req.estimateMicro < 0) throw new Error("Invalid LLM cost estimate");
  return db.transaction(async tx => {
    await tx.execute(sql`lock table ${llmUsage} in share row exclusive mode`);
    const chat = req.purpose === "chat";
    const purposes = chat ? CHAT_USAGE_PURPOSES : req.purpose === "ask" ? POST_ASK_USAGE_PURPOSES : req.purpose === "ask_village" ? NUSHI_USAGE_PURPOSES : PUBLIC_USAGE_PURPOSES;
    const budget = await getBudgetStatus(tx, req.now, req.env, purposes);
    const disabled = budget.state === "stopped" || (budget.state === "degraded" && !["primary", "embed", "chat", "ask"].includes(req.role));
    if (disabled) throw new BudgetPausedError(budget.state, budgetResumeAt(req.now), req.role);
    const committed = await getMonthlyCostMicro(tx, req.now, purposes);
    if (committed + req.estimateMicro > budget.budgetMicro) throw new BudgetPausedError(budget.state, budgetResumeAt(req.now), req.role, "insufficient");
    const [row] = await tx.insert(llmUsage).values({ engine: req.engine, model: req.model, purpose: req.purpose, costUsdMicro: req.estimateMicro, reserved: true, createdAt: req.now }).returning({ id: llmUsage.id });
    return row.id;
  });
}

export async function releaseReservation(db: Db, id: number): Promise<void> {
  await db.delete(llmUsage).where(and(eq(llmUsage.id, id), eq(llmUsage.reserved, true)));
}

// Replacing the same row makes settlement idempotent. If persistence fails, retain
// the conservative reservation instead of losing a charged call from the budget.
export async function settleReservation(db: Db, id: number, usage: { inputTokens: number; outputTokens: number; now?: Date; env?: LlmEnv }): Promise<number | null> {
  const [row] = await db.select().from(llmUsage).where(eq(llmUsage.id, id));
  if (!row) {
    console.warn(`[llm] reservation ${id} is missing; discarding its pending settlement`);
    return null;
  }
  const cost = costMicro(row.engine, row.model, usage.inputTokens, usage.outputTokens, usage.env);
  await db.update(llmUsage).set({ costUsdMicro: cost, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, reserved: false, createdAt: usage.now ?? new Date() }).where(eq(llmUsage.id, id));
  return cost;
}

export type BudgetStatus = {
  state: BudgetState;
  usedMicro: number;
  budgetMicro: number;
  // Percentage of the cap spent; 100 if the cap is zero.
  percent: number;
  monthStart: Date;
  // Start of the next UTC month: stopped usage always resumes by this time.
  monthEnd: Date;
};

export async function getBudgetStatus(db: Db, now: Date = new Date(), env: LlmEnv = process.env, purposes: readonly UsagePurpose[] = PUBLIC_USAGE_PURPOSES): Promise<BudgetStatus> {
  const chat = purposes.length === 1 && purposes[0] === "chat";
  const ask = purposes.length === 1 && purposes[0] === "ask";
  const nushi = purposes.length === 1 && purposes[0] === "ask_village";
  const usedMicro = await monthlyCostMicro(db, now, purposes, "exclude");
  const budgetMicro = chat ? chatMonthlyBudgetMicro(env) : ask ? postAskMonthlyBudgetMicro(env) : nushi ? nushiMonthlyBudgetMicro(env) : monthlyBudgetMicro(env);
  const { start, end } = monthRangeUtc(now);
  return {
    state: chat || ask || nushi ? usedMicro >= budgetMicro ? "stopped" : "normal" : budgetStateFor(usedMicro, budgetMicro),
    usedMicro,
    budgetMicro,
    percent: budgetMicro > 0 ? (usedMicro / budgetMicro) * 100 : 100,
    monthStart: start,
    monthEnd: end,
  };
}

export function getChatBudgetStatus(db: Db, now = new Date(), env: LlmEnv = process.env): Promise<BudgetStatus> {
  return getBudgetStatus(db, now, env, CHAT_USAGE_PURPOSES);
}

export function getPostAskBudgetStatus(db: Db, now = new Date(), env: LlmEnv = process.env): Promise<BudgetStatus> {
  return getBudgetStatus(db, now, env, POST_ASK_USAGE_PURPOSES);
}

// Checked by jobs before execution.
export async function getBudgetState(db: Db, now: Date = new Date(), env: LlmEnv = process.env): Promise<BudgetState> {
  return (await getBudgetStatus(db, now, env)).state;
}

const RECHECK_MS = 15 * 60 * 1000;

// Next check for budget-delayed jobs: in 15 minutes, since configuration may raise the cap, and no later than the next month's start.
export function budgetResumeAt(now: Date = new Date()): Date {
  const { end } = monthRangeUtc(now);
  return new Date(Math.min(now.getTime() + RECHECK_MS, end.getTime()));
}

export type UsageRow = {
  engine: string;
  model: string;
  purpose: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicro: number;
};

// Current-month costs by engine/model/purpose, highest cost first.
export async function getMonthlyBreakdown(db: Db, now: Date = new Date()): Promise<UsageRow[]> {
  const { start, end } = monthRangeUtc(now);
  const cost = sql<string>`coalesce(sum(${llmUsage.costUsdMicro}), 0)`;
  const rows = await db
    .select({
      engine: llmUsage.engine,
      model: llmUsage.model,
      purpose: llmUsage.purpose,
      calls: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${llmUsage.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${llmUsage.outputTokens}), 0)`,
      costMicro: cost,
    })
    .from(llmUsage)
    .where(and(gte(llmUsage.createdAt, start), lt(llmUsage.createdAt, end), eq(llmUsage.reserved, false)))
    .groupBy(llmUsage.engine, llmUsage.model, llmUsage.purpose)
    .orderBy(desc(cost), llmUsage.engine, llmUsage.model, llmUsage.purpose);
  return rows.map((r) => ({
    engine: r.engine,
    model: r.model,
    purpose: r.purpose,
    calls: Number(r.calls),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costMicro: Number(r.costMicro),
  }));
}

// Estimate admission can defer work even when settled spending is still normal.
export async function countBudgetReservationWaits(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(jobs).where(budgetReservationWaitCondition());
  return Number(row?.n ?? 0);
}
