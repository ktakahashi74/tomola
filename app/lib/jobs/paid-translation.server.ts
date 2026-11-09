import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { and, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.server";
import { jobs } from "../db/schema";
import type { TranslationEngine, TranslationRequest, TranslationResult } from "../llm/types";

export type PaidTranslationCall = { result: TranslationResult; costUsdMicro: number };

// Deletion can precede a provider response. Fence later checkpoint writes too,
// including a response whose inspection subsequently fails and is retried.
export async function discardPaidTranslationCalls(db: Db, condition: SQL): Promise<void> {
  await db.update(jobs).set({ payload: sql`(${jobs.payload} - 'paidTranslationCalls') || case when ${jobs.status} = 'running' then '{"discardPaidTranslationCalls":true}'::jsonb else '{}'::jsonb end` }).where(and(condition, inArray(jobs.status, ["queued", "running", "failed"])));
}

// Queue metadata is not part of a handler's validated input schema.
export function withoutPaidTranslationMetadata(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const { paidTranslationCalls: _calls, discardPaidTranslationCalls: _discard, ...input } = payload as Record<string, unknown>;
  return input;
}
type Calls = Record<string, PaidTranslationCall>;
const storage = new AsyncLocalStorage<{ calls: Calls; save: (key: string, call: PaidTranslationCall) => Promise<void> }>();
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
  return value;
}

export function translationCallKey(engine: Pick<TranslationEngine, "id" | "model">, req: TranslationRequest, purpose: string, role: string): string {
  const { signal: _signal, ...input } = req;
  return createHash("sha256").update(JSON.stringify(ordered({ engine: engine.id, model: engine.model, purpose, role, input }))).digest("hex");
}
export const hasPaidTranslationCall = (key: string): boolean => !!storage.getStore()?.calls[key];
export function withPaidTranslationCalls<T>(payload: unknown, save: (key: string, call: PaidTranslationCall) => Promise<void>, run: () => T): T {
  const saved = (payload as { paidTranslationCalls?: Calls } | null)?.paidTranslationCalls;
  const calls: Calls = {};
  for (const [key, call] of Object.entries(saved ?? {})) {
    if (/^[a-f0-9]{64}$/.test(key) && call && Number.isSafeInteger(call.costUsdMicro) && call.costUsdMicro >= 0 &&
        typeof call.result?.text === "string" && typeof call.result.model === "string" && typeof call.result.promptVersion === "string" &&
        Number.isSafeInteger(call.result.inputTokens) && Number.isSafeInteger(call.result.outputTokens)) calls[key] = call;
  }
  return storage.run({ calls, save }, run);
}
// Persist successful paid output before structure inspection. A later job attempt
// replays the same call, including its usage totals, without another reservation.
export async function paidTranslationCall(key: string, call: () => Promise<PaidTranslationCall>): Promise<PaidTranslationCall> {
  const state = storage.getStore();
  if (state?.calls[key]) return state.calls[key];
  const result = await call();
  if (state) { await state.save(key, result); state.calls[key] = result; }
  return result;
}
