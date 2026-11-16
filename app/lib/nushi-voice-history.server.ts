import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { profiles, villageEvents } from "./db/schema";
import { DELETED_MEMBER_HANDLE } from "./deleted-member";

export const NUSHI_VOICE_EVENT_ACTIONS = ["nushi_voice", "moderation_nushi_voice"];

export async function nushiVoiceHistory(db: Db, villageIds: string[]) {
  if (!villageIds.length) return [];
  const rows = await db.select({ id: villageEvents.id, villageId: villageEvents.villageId, actor: profiles.handle,
    action: villageEvents.action, detail: villageEvents.detail, hidden: villageEvents.nushiVoiceHidden, date: villageEvents.createdAt })
    .from(villageEvents).leftJoin(profiles, eq(profiles.userId, villageEvents.actorId))
    .where(and(inArray(villageEvents.villageId, villageIds), inArray(villageEvents.action, NUSHI_VOICE_EVENT_ACTIONS)))
    .orderBy(desc(villageEvents.id));
  return rows.map(row => ({ id: row.id, villageId: row.villageId, actor: row.action === "moderation_nushi_voice" ? null : row.actor ?? DELETED_MEMBER_HANDLE,
    removed: row.action === "moderation_nushi_voice", hidden: row.hidden, text: row.detail.text ?? "", date: row.date.toISOString() }));
}
