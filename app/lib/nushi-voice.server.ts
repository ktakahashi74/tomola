import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { profiles, villageEvents, villages } from "./db/schema";
import { isVillageOwner, lockModeratedVillage, lockVillageActor } from "./village-moderation.server";
import { villageDescriptionText } from "./villages";
import { villagesEnabled } from "./villages-enabled.server";
import { nushiVoiceEnabled } from "./nushi-config.server";
import { NUSHI_VOICE_MAX, nushiVoiceHref } from "./nushi-voice";
import type { LlmEnv } from "./llm/types";

const voiceActions = ["nushi_voice", "moderation_nushi_voice"];
export type NushiVoice = { text: string; eventId: number | null };

export { personalVoiceVillage } from "./personal-villages.server";

export async function readNushiVoice(db: Db, villageId: string, env: LlmEnv = process.env): Promise<NushiVoice | undefined> {
  if (!nushiVoiceEnabled(env)) return;
  const [village] = await db.select({ text: villages.nushiVoice, kind: villages.kind, language: villages.language }).from(villages).where(eq(villages.id, villageId));
  if (!village || village.language || !["personal", "open", "invite_public"].includes(village.kind)) return;
  const [event] = await db.select({ id: villageEvents.id }).from(villageEvents)
    .where(and(eq(villageEvents.villageId, villageId), inArray(villageEvents.action, voiceActions)))
    .orderBy(desc(villageEvents.id)).limit(1);
  return { text: village.text, eventId: event?.id ?? null };
}

export async function nushiVoiceCurrent(db: Db, villageId: string, voice: NushiVoice | undefined, env: LlmEnv) {
  const current = await readNushiVoice(db, villageId, env);
  return current?.text === voice?.text && current?.eventId === voice?.eventId;
}

export async function setNushiVoice(db: Db, userId: string, villageId: string, raw: unknown, env: LlmEnv = process.env) {
  if (!villagesEnabled(env) || !nushiVoiceEnabled(env)) return { ok: false as const, error: "not_found" as const };
  const text = villageDescriptionText(raw, NUSHI_VOICE_MAX);
  if (text === null) return { ok: false as const, error: "invalid_voice" as const };
  return db.transaction(async tx => {
    const actor = await lockVillageActor(tx, userId);
    if (!actor || actor.suspendedUntil && actor.suspendedUntil > new Date()) return { ok: false as const, error: "forbidden" as const };
    const village = await lockModeratedVillage(tx, villageId);
    if (!village || village.language || village.endedAt || !["personal", "open", "invite_public"].includes(village.kind)) return { ok: false as const, error: "not_found" as const };
    if (village.kind === "personal" ? village.ownerId !== userId : !await isVillageOwner(tx, village.id, userId)) return { ok: false as const, error: "forbidden" as const };
    if (village.nushiVoice !== text) {
      await tx.update(villages).set({ nushiVoice: text }).where(eq(villages.id, village.id));
      await tx.insert(villageEvents).values({ villageId, actorId: userId, actorHandle: actor.handle, action: "nushi_voice", detail: { text, oldText: village.nushiVoice } });
    }
    return { ok: true as const };
  });
}

export async function publicNushiVoice(db: Db, villageId: string, env: LlmEnv = process.env) {
  const voice = await readNushiVoice(db, villageId, env);
  if (!voice) return;
  const rows = await db.select({ id: villageEvents.id, actor: villageEvents.actorHandle, action: villageEvents.action, detail: villageEvents.detail, date: villageEvents.createdAt })
    .from(villageEvents).where(and(eq(villageEvents.villageId, villageId), inArray(villageEvents.action, voiceActions))).orderBy(desc(villageEvents.id));
  return { text: voice.text, history: rows.map(row => ({ id: row.id, actor: row.actor, removed: row.action === "moderation_nushi_voice", text: row.detail.text ?? "", date: row.date.toISOString() })) };
}

export async function nushiVoiceLink(db: Db, villageId: string, eventId: number | null, env: LlmEnv = process.env) {
  if (!nushiVoiceEnabled(env)) return;
  const [row] = await db.select({ slug: villages.slug, kind: villages.kind, handle: profiles.handle }).from(villages)
    .leftJoin(profiles, eq(profiles.userId, villages.ownerId)).where(eq(villages.id, villageId));
  const slug = row?.kind === "personal" ? row.handle && `@${row.handle}` : row?.slug;
  return slug ? nushiVoiceHref(slug, eventId) : undefined;
}
