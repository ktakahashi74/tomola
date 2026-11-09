import type { Db } from "~/lib/db/client.server";
import { getBudgetStatus, getChatBudgetStatus, monthRangeUtc, type BudgetStatus } from "~/lib/llm/usage.server";
import { primaryEngineId, primaryModelOf, resolveChatEngine } from "~/lib/llm/config.server";
import { translationEstimate } from "~/lib/llm/metering.server";
import type { LlmEnv, TranslationRequest } from "~/lib/llm/types";
import { LANGS } from "~/lib/languages";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { NORMAL_WAIT, NORMAL_WAITS, type TranslationWait, type TranslationWaits } from "~/lib/translation-wait";

// The budget behind a missing translation, in the terms a reader is told (app/lib/translation-wait.ts).
//
// Every call is admitted through a reservation (reserveUsage), which refuses when the settled spending plus the call's estimate would pass the budget. The
// settled spending therefore never reaches the budget: the work stops while some budget is left. So "stopped" is read from what is left: when it cannot cover the
// smallest call the current engine makes, nothing can be admitted any more. A larger job may be refused while a smaller one still
// fits; that middle state stays "normal" (it is only waiting).
const STOPPED: TranslationWait = { kind: "stopped" };

export function translationWaitFor(status: BudgetStatus, smallestEstimateMicro = 0): TranslationWait {
  if (status.budgetMicro <= 0) return STOPPED;
  const left = status.budgetMicro - status.usedMicro;
  // At "degraded" the primary translation still runs; only a budget that cannot admit even the smallest call is a pause.
  if (status.state !== "stopped" && left >= smallestEstimateMicro) return NORMAL_WAIT;
  return STOPPED;
}

// A lower bound for reservations across supported language pairs and the scope's request shapes. Zero when it cannot be worked out
// (the engine is not configured, say), which only means that the remaining amount is not used to judge.
export function smallestEstimate(scope: keyof TranslationWaits, env: LlmEnv = process.env): number {
  try {
    const engine = scope === "chat" ? resolveChatEngine(env) : { id: primaryEngineId(env), model: primaryModelOf(env) };
    // Language-specific instructions and short plain-text requests can cost less than a ja -> en title.
    // Use the cheapest supported shape so a job that still fits never appears stopped.
    let minimum = Infinity;
    const shapes: Partial<TranslationRequest>[] = scope === "chat" ? [{ chat: { context: [] } }]
      : [{ field: "title" }, { village: "name" }, { village: "description" }, { invitationNote: true }];
    for (const from of LANGS) for (const to of LANGS) if (from !== to) for (const shape of shapes) {
      minimum = Math.min(minimum, translationEstimate(engine.id, engine.model, { text: "x", from, to, ...shape }, env));
    }
    return minimum;
  } catch {
    return 0;
  }
}

export async function getPostTranslationWait(db: Db, now: Date = new Date(), env: LlmEnv = process.env): Promise<TranslationWait> {
  return translationWaitFor(await getBudgetStatus(db, now, env), smallestEstimate("posts", env));
}

export async function getChatTranslationWait(db: Db, now: Date = new Date(), env: LlmEnv = process.env): Promise<TranslationWait> {
  if (!villageChatEnabled(env)) return NORMAL_WAIT;
  return translationWaitFor(await getChatBudgetStatus(db, now, env), smallestEstimate("chat", env));
}

// Not remembered: for tests and callers that want the ledger as it is.
export async function getTranslationWaits(db: Db, now: Date = new Date(), env: LlmEnv = process.env): Promise<TranslationWaits> {
  const [posts, chat] = await Promise.all([getPostTranslationWait(db, now, env), getChatTranslationWait(db, now, env)]);
  return { posts, chat };
}

// What pages use: each budget is remembered for a minute (never past the end of the UTC month, when the state changes by itself), since the state changes
// only when the budget runs out, at a month's end, or when the settings change. A ledger that cannot be read must not take a page down, so it reads as the
// ordinary state and is not remembered, so the next request reads it again.
const REMEMBER_MS = 60_000;
type Remembered = { wait: TranslationWait; until: number; generation: number };
const remembered = new WeakMap<object, Partial<Record<keyof TranslationWaits, Remembered>>>();
type Pending = { value: Promise<TranslationWait>; until: number; generation: number };
const pending = new WeakMap<object, Partial<Record<keyof TranslationWaits, Pending>>>();
let generation = 0;

// Makes everything remembered so far stale (for tests that change the ledger or the settings within one process).
export function resetTranslationWaitCache(): void {
  generation++;
}

async function readScope(getDb: () => Promise<Db>, scope: keyof TranslationWaits, now: Date): Promise<TranslationWait> {
  try {
    const db = await getDb();
    const entry = remembered.get(db)?.[scope];
    if (entry && entry.generation === generation && entry.until > now.getTime()) return entry.wait;
    const existing = pending.get(db)?.[scope];
    if (existing && existing.generation === generation && existing.until > now.getTime()) return existing.value;
    const currentGeneration = generation;
    const until = Math.min(now.getTime() + REMEMBER_MS, monthRangeUtc(now).end.getTime());
    const value = (scope === "posts" ? getPostTranslationWait(db, now) : getChatTranslationWait(db, now)).then(wait => {
      if (pending.get(db)?.[scope] === flight && generation === currentGeneration) {
        remembered.set(db, { ...remembered.get(db), [scope]: { wait, generation: currentGeneration, until } });
      }
      return wait;
    }).catch(error => {
      console.error("[translation-wait] could not read the budget:", error instanceof Error ? error.message : "unknown");
      return NORMAL_WAIT;
    }).finally(() => {
      const requests = pending.get(db);
      if (requests?.[scope] === flight) delete requests[scope];
    });
    const flight = { value, generation: currentGeneration, until };
    pending.set(db, { ...pending.get(db), [scope]: flight });
    return value;
  } catch (error) {
    console.error("[translation-wait] could not read the budget:", error instanceof Error ? error.message : "unknown");
    return NORMAL_WAIT;
  }
}

export function readPostTranslationWait(getDb: () => Promise<Db>, now: Date = new Date()): Promise<TranslationWait> {
  return readScope(getDb, "posts", now);
}

export async function readTranslationWaits(getDb: () => Promise<Db>, now: Date = new Date()): Promise<TranslationWaits> {
  const [posts, chat] = await Promise.all([readScope(getDb, "posts", now), readScope(getDb, "chat", now)]);
  return posts === NORMAL_WAIT && chat === NORMAL_WAIT ? NORMAL_WAITS : { posts, chat };
}
