import { randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, lte } from "drizzle-orm";
import type { Db, Tx } from "./db/client.server";
import { chatNushiRequests, chatNushiReservations, nushiQuotaLock, nushiRequests, nushiReservations } from "./db/schema";
import { BudgetPausedError } from "./llm/errors.server";
import type { LlmEnv } from "./llm/types";
import { nushiLimits } from "./nushi-config.server";
import { DeferJob } from "./jobs/queue.server";

export const NUSHI_MAX_ATTEMPTS = 3;
const LEASE_MS = 300_000;
const BUSY_DELAY_MS = 5_000;
const RETRY_DELAY_MS = 30_000;
const activeStates = ["pending", "processing"];
export const dayOf = (now: Date) => now.toISOString().slice(0, 10);

type RequestTable = typeof nushiRequests | typeof chatNushiRequests;
type ReservationTable = typeof nushiReservations | typeof chatNushiReservations;
type LifecycleOptions<T extends RequestTable> = {
  requests: T;
  reservations: ReservationTable;
  sharedRequests: RequestTable;
  sharedReservations: ReservationTable;
  enabled: (env: LlmEnv) => boolean;
  countShared: (env: LlmEnv) => boolean;
  topic?: (request: T["$inferSelect"]) => number;
  intervalLimited?: (db: Tx, request: T["$inferSelect"], now: Date, env: LlmEnv) => Promise<boolean>;
  pendingLeaseCounts?: boolean;
  leasedMessage: string;
  busyMessage: string;
  retryMessage: string;
};

export async function quotaLock(db: Tx) {
  await db.insert(nushiQuotaLock).values({ id: 1 }).onConflictDoNothing();
  await db.select().from(nushiQuotaLock).where(eq(nushiQuotaLock.id, 1)).for("update");
}

export function nushiRequestLifecycle<T extends RequestTable>(options: LifecycleOptions<T>) {
  const requests: RequestTable = options.requests;
  const { reservations, sharedRequests, sharedReservations } = options;
  const active = () => inArray(requests.state, activeStates);

  async function finish(db: Db, id: string, failure: string, token?: string) {
    await db.update(requests).set({
      state: failure === "disabled" || failure === "changed" ? "cancelled" : "failed",
      failure, leaseUntil: null,
    }).where(and(eq(requests.id, id), active(), token ? eq(requests.token, token) : undefined));
  }

  // Call under the same quota lock as claim and publication.
  async function reserve(db: Tx, request: T["$inferSelect"], limits: ReturnType<typeof nushiLimits>, now: Date, env: LlmEnv, authors: string[] = []) {
    const requestId = request.id;
    const quotas: Array<[string, number]> = [[`member:${request.callerId}`, limits.member]];
    if (options.topic) quotas.push([`topic:${options.topic(request)}`, limits.topic]);
    quotas.push([`village:${request.villageId}`, limits.village]);
    for (const author of authors) quotas.push([`author:${author}`, limits.author]);
    const day = dayOf(now);
    const countShared = options.countShared(env);
    for (const [key, cap] of quotas) {
      const [own] = await db.select({ day: reservations.day }).from(reservations)
        .where(and(eq(reservations.requestId, requestId), eq(reservations.key, key)));
      const used = await countReservations(db, reservations, day, key);
      const shared = countShared ? await countReservations(db, sharedReservations, day, key) : 0;
      if (used + shared + (own?.day === day ? 0 : 1) > cap) return false;
    }
    for (const [key] of quotas) await db.insert(reservations).values({ requestId, key, day })
      .onConflictDoUpdate({ target: [reservations.requestId, reservations.key], set: { day } });
    return true;
  }

  async function claim(db: Db, id: string, now: Date, env: LlmEnv) {
    return db.transaction(async tx => {
      await quotaLock(tx);
      const [row] = await tx.select().from(requests).where(eq(requests.id, id)).for("update");
      // Drizzle sees the common columns of the union. Each query returns the
      // full row from the concrete table supplied to this lifecycle.
      const request = row as T["$inferSelect"] | undefined;
      if (!request || !activeStates.includes(request.state)) return null;
      const unavailable = request.expiresAt <= now ? "expired" : !options.enabled(env) ? "disabled" : null;
      if (unavailable) { await finish(tx, id, unavailable); return null; }
      if ((request.state === "processing" || options.pendingLeaseCounts) && request.leaseUntil && request.leaseUntil > now) {
        throw new DeferJob(request.leaseUntil, options.leasedMessage);
      }
      if (request.attempts >= NUSHI_MAX_ATTEMPTS) { await finish(tx, id, "unavailable"); return null; }
      const limits = nushiLimits(env);
      const running = await countRunning(tx, requests, now);
      const shared = options.countShared(env) ? await countRunning(tx, sharedRequests, now) : 0;
      if (running + shared >= limits.concurrent) throw new DeferJob(new Date(now.getTime() + BUSY_DELAY_MS), options.busyMessage);
      if (await options.intervalLimited?.(tx, request, now, env)) { await finish(tx, id, "interval"); return null; }
      if (!await reserve(tx, request, limits, now, env)) { await finish(tx, id, "limit"); return null; }
      const [claimed] = await tx.update(requests).set({
        state: "processing", attempts: request.attempts + 1,
        token: randomUUID(), leaseUntil: new Date(now.getTime() + LEASE_MS),
      }).where(eq(requests.id, id)).returning();
      return claimed as T["$inferSelect"];
    });
  }

  async function retryOrFinish(db: Db, request: T["$inferSelect"], error: unknown, clock: () => Date) {
    // Provider errors can include member content. Only report the fixed reason.
    const { id, token } = request;
    if (error instanceof BudgetPausedError) { await finish(db, id, "budget", token!); return; }
    if (error instanceof DeferJob) throw error;
    if (request.attempts < NUSHI_MAX_ATTEMPTS && clock() < request.expiresAt) {
      await db.update(requests).set({ state: "pending", leaseUntil: null })
        .where(and(eq(requests.id, id), eq(requests.token, token!), eq(requests.state, "processing")));
      throw new DeferJob(new Date(clock().getTime() + RETRY_DELAY_MS), options.retryMessage);
    }
    await finish(db, id, "unavailable", token!);
  }

  async function expire(db: Db, now: Date, env: LlmEnv) {
    if (!options.enabled(env)) return;
    const rows = await db.select({ id: requests.id }).from(requests)
      .where(and(active(), lte(requests.expiresAt, now))).limit(100);
    for (const row of rows) await finish(db, row.id, "expired");
  }

  return { active, claim, expire, finish, reserve, retryOrFinish };
}

async function countReservations(db: Tx, table: ReservationTable, day: string, key: string) {
  const [row] = await db.select({ n: count() }).from(table).where(and(eq(table.day, day), eq(table.key, key)));
  return row.n;
}

async function countRunning(db: Tx, table: RequestTable, now: Date) {
  const [row] = await db.select({ n: count() }).from(table).where(and(eq(table.state, "processing"), gt(table.leaseUntil, now)));
  return row.n;
}
