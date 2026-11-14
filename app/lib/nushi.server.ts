import { enabledTargetLangs } from "./enabled-langs.server";
import { notificationEmailDedupeKey, enqueueImmediateEmails } from "./notifications.server";
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, jobs, nushiAnswers, nushiQuotaLock, nushiRequests, nushiReservations, nushiSources, nushiTranslations, notifications, profiles, villages } from "./db/schema";
import { callsNushi } from "./nushi-call.server";
import { NUSHI_PROMPT_VERSION, nushiEnabled, nushiLimits, nushiModel } from "./nushi-config.server";
import { nushiCaller, nushiMaterials, nushiPlace, nushiPlaces, nushiSourceLabels, snapshotsCurrent, nushiMaterialIndex, reconstructNushiMaterials, type NushiMaterials } from "./nushi-materials.server";
import { questionPrompt, verifyQuestionAnswer } from "./ai-question-answer.server";
import { AI_QUESTION_LIMITS, clipQuestionText, type AiQuestionAnswer } from "./ai-questions";
import { createJsonCompleter, type JsonCompleter } from "./llm/completion.server";
import { primaryEngineId } from "./llm/config.server";
import { completionEstimate, meteredCall } from "./llm/metering.server";
import { BudgetPausedError } from "./llm/errors.server";
import { enqueue, DeferJob, type JobHandlers } from "./jobs/queue.server";
import type { EmbeddingEngine, LlmEnv } from "./llm/types";
import type { Lang } from "./languages";

export const NUSHI_JOB = "answer_nushi";
const active = () => inArray(nushiRequests.state, ["pending", "processing"]);
const dayOf = (now: Date) => now.toISOString().slice(0, 10);

// Called exactly once, in the human publication transaction; edits and drafts
// never enter here. Suppressing a call does not alter the member's original.
export async function requestNushi(db: Db, entryId: number, suppress = false, now = new Date(), env: LlmEnv = process.env) {
  if (suppress || !nushiEnabled(env)) return;
  const [entry] = await db.select().from(entries).where(eq(entries.id, entryId));
  if (!entry || entry.deletedAt || entry.hiddenAt || !entry.sourceHash || !await callsNushi(entry.body)) return;
  const threadId = entry.threadId ?? entry.id;
  const place = await nushiPlace(db, threadId, env);
  if (!place) return;
  const [request] = await db.insert(nushiRequests).values({ entryId, threadId, villageId: place.village.id, callerId: entry.authorId,
    revision: entry.mentionRevision, sourceHash: entry.sourceHash, createdAt: now, expiresAt: new Date(now.getTime() + nushiLimits(env).ttlSeconds * 1000) })
    .onConflictDoNothing().returning();
  if (request) await enqueue(db, NUSHI_JOB, { requestId: request.id }, { priority: 1, dedupeKey: `nushi:${request.id}`, maxAttempts: 3 });
}

// A daily citation notice is mailed once, including after a permanent delivery failure.
async function enqueueNushiEmails(db: Db, created: Array<{ id: number; userId: string; kind: "nushi_result" | "nushi_cited" }>, now: Date) {
  if (!created.length) return;
  const previous = await db.select({ key: jobs.dedupeKey }).from(jobs).where(inArray(jobs.dedupeKey, created.map(row => notificationEmailDedupeKey(row.id))));
  const keys = new Set(previous.map(row => row.key));
  await enqueueImmediateEmails(db, created.filter(row => !keys.has(notificationEmailDedupeKey(row.id))), { now });
}
async function notifyResult(db: Db, request: typeof nushiRequests.$inferSelect, now: Date) {
  if (!request.callerId) return;
  await db.insert(notifications).values({ userId: request.callerId, kind: "nushi_result", nushiRequestId: request.id, threadId: request.threadId, createdAt: now }).onConflictDoNothing();
  const rows = await db.select({ id: notifications.id, userId: notifications.userId }).from(notifications)
    .where(and(eq(notifications.nushiRequestId, request.id), eq(notifications.kind, "nushi_result"))).for("update");
  await enqueueNushiEmails(db, rows.map(row => ({ ...row, kind: "nushi_result" })), now);
}
async function finish(db: Db, id: string, failure: string, now: Date, token?: string) {
  await db.transaction(async tx => {
    const [row] = await tx.update(nushiRequests).set({ state: failure === "disabled" || failure === "changed" ? "cancelled" : "failed", failure, leaseUntil: null })
      .where(and(eq(nushiRequests.id, id), active(), token ? eq(nushiRequests.token, token) : undefined)).returning();
    if (row) await notifyResult(tx, row, now);
  });
}

async function quotaLock(db: Db) {
  await db.insert(nushiQuotaLock).values({ id: 1 }).onConflictDoNothing();
  await db.select().from(nushiQuotaLock).where(eq(nushiQuotaLock.id, 1)).for("update");
}
async function reserveDaily(db: Db, requestId: string, limits: Array<[string, number]>, now: Date) {
  const day = dayOf(now);
  for (const [key, cap] of limits) {
    const [own] = await db.select().from(nushiReservations).where(and(eq(nushiReservations.requestId, requestId), eq(nushiReservations.key, key)));
    const [used] = await db.select({ n: count() }).from(nushiReservations).where(and(eq(nushiReservations.day, day), eq(nushiReservations.key, key)));
    if (used.n + (own?.day === day ? 0 : 1) > cap) return false;
  }
  for (const [key] of limits) await db.insert(nushiReservations).values({ requestId, key, day }).onConflictDoUpdate({ target: [nushiReservations.requestId, nushiReservations.key], set: { day } });
  return true;
}

async function claim(db: Db, id: string, now: Date, env: LlmEnv) {
  return db.transaction(async tx => {
    await quotaLock(tx);
    const [request] = await tx.select().from(nushiRequests).where(eq(nushiRequests.id, id)).for("update");
    if (!request || !["pending", "processing"].includes(request.state)) return null;
    if (request.expiresAt <= now) { await finish(tx, id, "expired", now); return null; }
    if (!nushiEnabled(env)) { await finish(tx, id, "disabled", now); return null; }
    if (request.state === "processing" && request.leaseUntil && request.leaseUntil > now) throw new DeferJob(request.leaseUntil, "Nushi is processing this request");
    if (request.attempts >= 3) { await finish(tx, id, "unavailable", now); return null; }
    const limits = nushiLimits(env);
    const [running] = await tx.select({ n: count() }).from(nushiRequests).where(and(eq(nushiRequests.state, "processing"), gt(nushiRequests.leaseUntil, now)));
    if (running.n >= limits.concurrent) throw new DeferJob(new Date(now.getTime() + 5000), "Nushi is busy");
    if (!await reserveDaily(tx, id, [[`member:${request.callerId}`, limits.member], [`topic:${request.threadId}`, limits.topic], [`village:${request.villageId}`, limits.village]], now)) {
      await finish(tx, id, "limit", now); return null;
    }
    const token = randomUUID();
    const [claimed] = await tx.update(nushiRequests).set({ state: "processing", token, leaseUntil: new Date(now.getTime() + 300_000), attempts: request.attempts + 1 }).where(eq(nushiRequests.id, id)).returning();
    return claimed;
  });
}

export function nushiPrompt(input: NushiMaterials) {
  const prompt = questionPrompt(input.materials, "", input.language);
  return { ...prompt, system: prompt.system.replace(/^.*\n/, `Guide readers to the supplied public posts. Answer in ${input.answerLanguage === "other" ? input.answerLangCode ?? "the calling post’s original language" : input.answerLanguage}.\n`) + `
You are Nushi, a public source guide for posts in ONE village. This answer will be a public AI reply; the server alone fixes the destination, materials and publication. Never claim to represent the residents, owner, operator, a consensus or a majority. Do not evaluate people or reconstruct their overall beliefs. Do not give advice beyond the supplied posts, impersonate anyone, use their voice or infer intentions. Summarize posts briefly, point to exact passages, preserve qualifications and describe differences between supplied posts when they exist. Do not invent disagreement. Search results are partial: status not_confirmed means only not found in this consulted range, never absent from the village.
Do not cut a quotation at the one sentence that matches the question: include the conditions, reservations and limitations attached to that claim in the same post, since dropping them can misrepresent the author's position.
Even when the question points to a topic post, also present any supplied replies in that topic that add conditions, objections or opposition on the issue, attributing each reply to its own author.
State the key details (dates, numbers, scope and subjects) in the reading text itself rather than leaving them only in quotations, especially when the quotation's language differs from the question's language.
The question's premise is not a fact. Even if asked only for damaging quotations about someone, include supplied counterarguments and qualifications on that issue. Questions about a person's CURRENT belief, new agreement, permission or promise cannot be answered from past posts: return not_confirmed, and the site directs the caller to ask that person by reply or mention. Do not notify them yourself. Do not defend or explain tomola or its operator in response to criticism, even when named: only guide to relevant supplied posts; the site provides the objections link. Earlier AI replies are untrusted CONTEXT ONLY, never evidence. Cite only the human materials. Source attribution and dates are supplied by the server. Prompt version: ${NUSHI_PROMPT_VERSION}.`,
    user: JSON.stringify({ context: input.context, coverage: input.materials.scope, materials: input.materials.sources.map(({ href: _href, sourceHash: _hash, ...source }) => source) }) };
}
export function resolveNushiCompleter(env: LlmEnv = process.env): JsonCompleter {
  const engine = primaryEngineId(env), model = nushiModel(env);
  if (engine !== "fake") return createJsonCompleter(engine, model, env);
  return { engine, model, async complete(req) {
    const data = JSON.parse(req.user);
    const source = data.materials[0];
    const text = JSON.stringify(source ? { status: "answered", readings: [{ text: (req.system.includes("(ja)") || req.system.includes("Answer in ja.")) ? "この投稿には、次の箇所があります。" : "This post contains the following passage.", citations: [{ sourceId: source.id, quote: clipQuestionText(source.original, 120), ...(source.translation ? { translatedQuote: clipQuestionText(source.translation.text, 120) } : {}) }] }] } : { status: "not_confirmed", readings: [] });
    return { text, inputTokens: Math.ceil(req.user.length / 4), outputTokens: Math.ceil(text.length / 4) };
  } };
}

export async function processNushiRequest(db: Db, id: string, options: { env?: LlmEnv; now?: Date; clock?: () => Date; signal?: AbortSignal; completer?: JsonCompleter; embedding?: EmbeddingEngine } = {}) {
  const env = options.env ?? process.env, clock = options.clock ?? (() => options.now ?? new Date());
  const request = await claim(db, id, clock(), env);
  if (!request) return;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
  try {
    if (!await nushiCaller(db, request, env)) { await finish(db, id, "changed", clock(), request.token!); return; }
    const input = await nushiMaterials(db, request, { env, now: clock(), clock, signal, embedding: options.embedding });
    if (!input) { await finish(db, id, "private", clock(), request.token!); return; }
    if (!await nushiCaller(db, request, env) || !await snapshotsCurrent(db, input.snapshots, request.villageId)) { await finish(db, id, "changed", clock(), request.token!); return; }
    const completer = options.completer ?? resolveNushiCompleter(env);
    const prompt = { ...nushiPrompt(input), signal };
    const { result } = await meteredCall(db, { engine: completer.engine, model: completer.model, purpose: "ask_village", role: "ask",
      estimateMicro: completionEstimate(completer.engine, completer.model, prompt.system, prompt.user, prompt.maxOutputTokens, env), now: clock(), clock, env, signal },
    () => completer.complete(prompt), value => ({ inputTokens: value.inputTokens, outputTokens: value.outputTokens }));
    const answer = verifyQuestionAnswer(result.text, input.materials);
    if (!answer) { await finish(db, id, "unverified", clock(), request.token!); return; }
    await db.transaction(async tx => {
      // Sources precede the request lock, matching edits and withdrawal triggers.
      await tx.select({ id: villages.id }).from(villages).where(eq(villages.id, request.villageId)).for("share");
      await tx.select({ id: entries.id }).from(entries).where(inArray(entries.id, input.snapshots.map(source => source.id))).orderBy(asc(entries.id)).for("share");
      await quotaLock(tx);
      const [current] = await tx.select().from(nushiRequests).where(eq(nushiRequests.id, id)).for("update");
      if (!current || current.state !== "processing" || current.token !== request.token) return;
      if (!nushiEnabled(env) || current.expiresAt <= clock() || !await nushiCaller(tx, current, env) || !await snapshotsCurrent(tx, input.snapshots, current.villageId) || !await reconstructNushiMaterials(tx, nushiMaterialIndex(input.materials.sources), input.language)) {
        await finish(tx, id, current.expiresAt <= clock() ? "expired" : "changed", clock(), request.token!); return;
      }
      const cited = new Set(answer.citations.map(citation => Number(/^e-(\d+)-/.exec(citation.sourceId)![1])));
      const authors = [...new Set(input.snapshots.filter(source => cited.has(source.id)).map(source => source.authorId))].filter(author => author !== current.callerId);
      const limits = nushiLimits(env);
      const quotas: Array<[string, number]> = [[`member:${current.callerId}`, limits.member], [`topic:${current.threadId}`, limits.topic], [`village:${current.villageId}`, limits.village], ...authors.map(author => [`author:${author}`, limits.author] as [string, number])];
      if (!await reserveDaily(tx, id, quotas, clock())) { await finish(tx, id, "limit", clock(), request.token!); return; }
      const [published] = await tx.insert(nushiAnswers).values({ requestId: id, answer, scope: { posts: new Set(input.materials.sources.map(source => source.id.replace(/-(title|body)$/, ""))).size, ...input.dates, truncated: input.materials.scope.truncated, materialIndex: nushiMaterialIndex(input.materials.sources), materialLanguage: input.language, answerLangCode: input.answerLangCode },
        lang: input.answerLanguage, engine: completer.engine, model: completer.model, promptVersion: NUSHI_PROMPT_VERSION, createdAt: clock() }).onConflictDoNothing().returning();
      if (!published) return;
      await tx.insert(nushiSources).values(input.snapshots.map(source => ({ answerId: published.id, entryId: source.id, revision: source.revision, sourceHash: source.sourceHash, authorId: source.authorId, author: source.author, createdAt: source.createdAt })));
      await tx.update(nushiRequests).set({ state: "answered", leaseUntil: null }).where(eq(nushiRequests.id, id));
      await notifyResult(tx, current, clock());
      if (answer.readings.length) for (const lang of enabledTargetLangs(input.answerLanguage)) await enqueue(tx, "translate_nushi", { answerId: published.id, lang }, { dedupeKey: `nushi-translation:${published.id}:${lang}`, maxAttempts: 2 });
      if (authors.length) {
        const recipients = await tx.select({ id: profiles.userId }).from(profiles).where(and(inArray(profiles.userId, authors), eq(profiles.nushiCitationNotifications, true)));
        for (const recipient of recipients) {
          const rows = await tx.insert(notifications).values({ userId: recipient.id, kind: "nushi_cited", nushiRequestId: id, nushiDay: dayOf(clock()), threadId: current.threadId, createdAt: clock() }).onConflictDoUpdate({
          target: [notifications.userId, notifications.nushiDay], targetWhere: sql`${notifications.kind} = 'nushi_cited'`,
          set: { mergedCount: sql`${notifications.mergedCount} + 1`, nushiRequestId: id, threadId: current.threadId },
        }).returning({ id: notifications.id, userId: notifications.userId });
          await enqueueNushiEmails(tx, rows.map(row => ({ ...row, kind: "nushi_cited" })), clock());
        }
      }
    });
  } catch (error) {
    // Never persist or log provider errors: they may contain a post or question.
    if (error instanceof BudgetPausedError) { await finish(db, id, "budget", clock(), request.token!); return; }
    if (error instanceof DeferJob) throw error;
    if (request.attempts < 3 && clock() < request.expiresAt) {
      await db.update(nushiRequests).set({ state: "pending", leaseUntil: null }).where(and(eq(nushiRequests.id, id), eq(nushiRequests.token, request.token!), eq(nushiRequests.state, "processing")));
      throw new DeferJob(new Date(clock().getTime() + 30_000), "Nushi is temporarily unavailable");
    }
    await finish(db, id, "unavailable", clock(), request.token!);
  }
}

export async function expireNushiRequests(db: Db, now = new Date(), env: LlmEnv = process.env) {
  if (!nushiEnabled(env)) return;
  const rows = await db.select({ id: nushiRequests.id }).from(nushiRequests).where(and(active(), lte(nushiRequests.expiresAt, now))).limit(100);
  for (const row of rows) await finish(db, row.id, "expired", now);
}
export const createNushiHandlers = (): JobHandlers => ({
  [NUSHI_JOB]: async (job, ctx) => {
    const id = (job.payload as { requestId?: unknown })?.requestId;
    if (typeof id === "string") await processNushiRequest(ctx.db, id, { now: ctx.now, clock: ctx.clock, signal: ctx.signal });
  },
  // Database withdrawal triggers create this durable handoff in the same transaction.
  email_nushi_result: async (job, ctx) => {
    const id = (job.payload as { notificationId?: unknown })?.notificationId;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
    await ctx.db.transaction(async tx => {
      const rows = await tx.select({ id: notifications.id, userId: notifications.userId }).from(notifications)
        .where(and(eq(notifications.id, id), eq(notifications.kind, "nushi_result"))).for("update");
      await enqueueNushiEmails(tx, rows.map(row => ({ ...row, kind: "nushi_result" })), ctx.now);
    });
  },
});

// All public representations use this gate; no cached translation bypasses it.
export async function readNushiAnswer(db: Db, id: number, language?: Lang, env: LlmEnv = process.env) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const [row] = await db.select({ answer: nushiAnswers, request: nushiRequests }).from(nushiAnswers).innerJoin(nushiRequests, eq(nushiRequests.id, nushiAnswers.requestId)).where(eq(nushiAnswers.id, id));
  if (!row) return null;
  const available = !row.answer.hiddenAt && !!await nushiPlace(db, row.request.threadId, env);
  const sources = available ? await db.select().from(nushiSources).where(eq(nushiSources.answerId, id)) : [];
  const current = available && await snapshotsCurrent(db, sources.map(source => ({ ...source, id: source.entryId, authorId: source.authorId ?? "" })), row.request.villageId);
  if (!current) return { id, requestId: row.request.id, entryId: row.request.entryId, threadId: row.request.threadId, hidden: true as const, reason: row.answer.hiddenReason ?? "disabled" };
  const [caller] = row.request.callerId ? await db.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.userId, row.request.callerId)) : [];
  const place = (await nushiPlace(db, row.request.threadId, env))!;
  const [translation] = language && language !== row.answer.lang ? await db.select().from(nushiTranslations).where(and(eq(nushiTranslations.answerId, id), eq(nushiTranslations.lang, language))) : [];
  return { id, requestId: row.request.id, entryId: row.request.entryId, threadId: row.request.threadId, hidden: false as const,
    answer: translation ? { ...row.answer.answer, readings: row.answer.answer.readings.map((reading, index) => ({ ...reading, text: translation.readings[index] ?? reading.text })) } : row.answer.answer,
    lang: translation?.lang ?? row.answer.lang, langCode: row.answer.scope.answerLangCode, originalLang: row.answer.lang, translated: !!translation, translationEngine: translation?.engine ?? null, translationModel: translation?.model ?? null,
    scope: { posts: row.answer.scope.posts, from: row.answer.scope.from, to: row.answer.scope.to, truncated: row.answer.scope.truncated }, engine: row.answer.engine, model: row.answer.model, promptVersion: row.answer.promptVersion, date: row.answer.createdAt.toISOString(),
    caller: caller?.handle ?? null, personal: place.village.kind === "personal", villageId: row.request.villageId, villageSlug: place.village.slug,
    labels: await nushiSourceLabels(db, id) };
}
export async function threadNushi(db: Db, threadId: number, entryIds: number[], language: Lang) {
  if (!nushiEnabled()) return { answers: [], requests: [] };
  const requests = await db.select().from(nushiRequests).where(and(eq(nushiRequests.threadId, threadId), inArray(nushiRequests.entryId, entryIds)));
  const answers = requests.length ? await db.select({ id: nushiAnswers.id }).from(nushiAnswers).where(inArray(nushiAnswers.requestId, requests.map(request => request.id))) : [];
  return { answers: (await Promise.all(answers.map(answer => readNushiAnswer(db, answer.id, language)))).filter(answer => answer !== null),
    requests: requests.filter(request => request.state !== "answered").map(request => ({ id: request.id, entryId: request.entryId, state: request.state, failure: request.failure })) };
}

export async function nushiCounts(db: Db, threadIds: readonly number[]) {
  const counts = new Map<number, number>();
  if (!nushiEnabled() || !threadIds.length) return counts;
  const rows = await db.select({ id: nushiAnswers.id, threadId: nushiRequests.threadId }).from(nushiAnswers).innerJoin(nushiRequests, eq(nushiRequests.id, nushiAnswers.requestId))
    .where(and(inArray(nushiRequests.threadId, [...threadIds]), isNull(nushiAnswers.hiddenAt)));
  const readable = new Set((await nushiPlaces(db, [...new Set(rows.map(row => row.threadId))])).map(row => row.topic.id));
  for (const row of rows) if (readable.has(row.threadId)) counts.set(row.threadId, (counts.get(row.threadId) ?? 0) + 1);
  return counts;
}
