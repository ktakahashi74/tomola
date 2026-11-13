import { and, eq, exists, gt, like, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.server";
import { chatMessageTranslations, jobs } from "../db/schema";
import { BUDGET_RESERVATION_WAIT } from "./defer-reasons";

// Share the persisted marker between reader state, operator counts and startup recovery.
export function budgetReservationWaitCondition() {
  return and(eq(jobs.status, "queued"), like(jobs.lastError, `deferred: [${BUDGET_RESERVATION_WAIT}] %`))!;
}

// Run once at worker startup. Keep the error marker so advancing run_at alone
// does not promise readers that translation is already in progress.
export async function resumeBudgetWaits(db: Db, now = new Date()): Promise<void> {
  const pausedChat = exists(db.select({ one: sql`1` }).from(chatMessageTranslations).where(and(
    eq(chatMessageTranslations.state, "paused"), eq(chatMessageTranslations.errorCode, "budget"),
    eq(chatMessageTranslations.messageId, sql`${jobs.payload}->>'messageId'`),
    eq(chatMessageTranslations.lang, sql`${jobs.payload}->>'lang'`),
    eq(chatMessageTranslations.sourceHash, sql`${jobs.payload}->>'sourceHash'`),
  )));
  await db.update(jobs).set({ runAt: now, updatedAt: now }).where(and(
    eq(jobs.status, "queued"), gt(jobs.runAt, now),
    or(budgetReservationWaitCondition(), and(eq(jobs.kind, "translate_chat"), pausedChat)),
  ));
}
