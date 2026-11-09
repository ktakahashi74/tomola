import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireMember } from "../auth/session.server";
import { getAuth } from "../auth/auth.server";
import { assertSameOrigin, siteOrigin } from "../http/csrf.server";
import { hitMemberLimit, rateLimitHeaders } from "../rate-limit.server";
import { pushSubscriptions } from "../db/schema";
import { browserIdentity } from "./endpoint.server";
import { pushConfig, webPushEnabled } from "./config.server";
import { currentPushId, ownPushSubscriptions, PushRegistrationError, reconcilePush, registerPush, stopPush, pushSessionCondition, pushStoppedValues } from "./subscriptions.server";
import { sendWebPush, type PushSender } from "./send.server";
import { pushMessage } from "./messages.server";
import { memberMailLocale } from "../mail/magic-link.server";

export const PUSH_INPUT_BYTES = 4096;
async function readInput(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json") || !request.body) throw new PushRegistrationError(400, "invalid");
  if (Number(request.headers.get("content-length")) > PUSH_INPUT_BYTES) throw new PushRegistrationError(413, "too_large");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > PUSH_INPUT_BYTES) { await reader.cancel(); throw new PushRegistrationError(413, "too_large"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) { if (error instanceof PushRegistrationError) throw error; throw new PushRegistrationError(400, "invalid"); }
}
const inputSchema = z.object({ identity: browserIdentity.nullable().optional(), subscription: z.unknown().optional(), id: z.string().uuid().optional(), all: z.boolean().optional() }).strict();
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });

export async function handlePushRequest(request: Request, operation: string, deps: { send?: PushSender } = {}) {
  if (!webPushEnabled() || !["state", "subscribe", "unsubscribe", "test"].includes(operation)) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method" }, 405);
  assertSameOrigin(request);
  // Require the exact Origin as well as the existing settings CSRF policy.
  if (request.headers.get("origin") !== siteOrigin() || request.headers.has("authorization")) return json({ error: "forbidden" }, 403);
  const authSession = await (await getAuth()).api.getSession({ headers: request.headers });
  if (!authSession || new Date(authSession.session.expiresAt) <= new Date()) return json({ error: "login" }, 401);
  const { db, user, profile } = await requireMember(request);
  const action = operation === "state" ? "push-state" : operation === "subscribe" ? "push-register" : operation === "test" ? "push-test" : null;
  if (action) {
    const rate = await hitMemberLimit(db, action, user.id);
    if (!rate.allowed) return Response.json({ error: "limit" }, { status: 429, headers: { ...rateLimitHeaders(rate), "Cache-Control": "private, no-store", Vary: "Cookie" } });
  }
  try {
    const parsed = inputSchema.safeParse(await readInput(request));
    if (!parsed.success) throw new PushRegistrationError(400, "invalid");
    const input = parsed.data;
    const authorization = { sessionId: authSession.session.id, expiresAt: new Date(authSession.session.expiresAt) };
    if (operation === "state") {
      const current = input.identity ? await reconcilePush(db, user.id, input.identity, authorization) : null;
      const [row] = current ? await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, current.id)) : [];
      const browserSub = input.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
      const matchesSubscription = !!row && row.endpoint === browserSub?.endpoint && row.p256dh === browserSub?.keys?.p256dh && row.auth === browserSub?.keys?.auth;
      return json({ userId: user.id, current: current ? { ...current, matchesSubscription } : null, registrations: await ownPushSubscriptions(db, user.id) });
    }
    if (operation === "subscribe") {
      if (!input.identity) throw new PushRegistrationError(400, "invalid");
      const registration = await registerPush(db, user.id, input.identity, input.subscription, request.headers.get("user-agent") ?? "", authorization);
      return json({ ok: true, ...registration });
    }
    if (operation === "unsubscribe") {
      if (input.all) await stopPush(db, user.id, null);
      else {
        if (!input.id) throw new PushRegistrationError(400, "invalid");
        const [own] = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(and(eq(pushSubscriptions.id, input.id), eq(pushSubscriptions.userId, user.id)));
        if (!own) throw new PushRegistrationError(404, "not_found");
        await stopPush(db, user.id, own.id);
      }
      return json({ ok: true });
    }
    const id = await currentPushId(db, user.id, input.identity);
    if (!id || input.id !== id) throw new PushRegistrationError(404, "not_found");
    const row = await db.transaction(async tx => {
      const now = new Date();
      const [row] = await tx.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, user.id), isNull(pushSubscriptions.stoppedReason),
        gt(pushSubscriptions.authorizedUntil, now), pushSessionCondition(user.id, now, pushSubscriptions.authorizingSessionId))).for("update");
      if (!row || !row.endpoint || !row.p256dh || !row.auth) throw new PushRegistrationError(404, "not_found");
      if (row.vapidPublicKey !== pushConfig()!.publicKey) return null;
      await tx.update(pushSubscriptions).set({ lastAttemptAt: now }).where(eq(pushSubscriptions.id, id));
      return { ...row, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };
    });
    if (!row) {
      console.error("[push] Test notification failed; check provider and VAPID configuration");
      return json({ ok: false, error: "send_failed" }, 503);
    }
    const result = await (deps.send ?? sendWebPush)({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify({ title: "tomola", body: pushMessage("test", memberMailLocale(profile.uiLocale, profile.homeArea)), tag: `test-${id.slice(0, 27)}`, url: "/settings#settings-push" }), { ttl: 60, topic: `test-${id.replaceAll("-", "").slice(0, 27)}` });
    await db.transaction(async tx => {
      const same = and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.generation, row.generation), isNull(pushSubscriptions.stoppedReason));
      if (result.kind === "accepted") await tx.update(pushSubscriptions).set({ lastAcceptedAt: new Date(), failures: 0 }).where(same);
      if (result.kind === "gone") await tx.update(pushSubscriptions).set(pushStoppedValues("expired")).where(same);
    });
    if (result.kind === "operator") console.error("[push] Test notification failed; check provider and VAPID configuration");
    return json({ ok: result.kind === "accepted", error: result.kind === "accepted" ? undefined : "send_failed" }, result.kind === "accepted" ? 200 : 503);
  } catch (error) {
    if (error instanceof PushRegistrationError) return json({ error: error.code }, error.status);
    if (error instanceof Response || (typeof error === "object" && error !== null && "status" in error && "data" in error)) throw error;
    // Do not attach a DB/library cause: it could include endpoint/key parameters.
    return json({ error: "registration_failed" }, 503);
  }
}
