import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, entryMentionSnapshots, entryRevisions, memberSignatures, translationRevisions, translations, user } from "./db/schema";
import { sourceHash } from "./source-hash.server";
import { canSeeHidden, getViewer } from "./roles.server";
import { publicTopicPlace, rootTopic, rootTopicOn } from "./visibility.server";

export const EDIT_GRACE_MS = 30 * 60_000;

// The caller holds the entry's write lock. Existing reactions also close the
// window on upgraded databases; the latch survives subsequent removals.
export async function withinEditGrace(db: Db, id: number, now: Date): Promise<boolean> {
  const [row] = await db.select({ createdAt: entries.createdAt, editedAt: entries.editedAt, started: entries.historyStartedAt,
    hidden: sql<boolean>`${entries.hiddenAt} is not null or ${rootTopic.hiddenAt} is not null`,
    reported: sql<boolean>`exists (select 1 from reports where reports.entry_id = entries.id and reports.status = 'open')`,
    engaged: sql<boolean>`exists (select 1 from votes where votes.entry_id = entries.id) or exists (select 1 from entries reply where reply.thread_id = entries.id or reply.parent_id = entries.id)`,
    revised: sql<boolean>`exists (select 1 from entry_revisions where entry_revisions.entry_id = entries.id)`,
  }).from(entries).innerJoin(rootTopic, rootTopicOn()).where(eq(entries.id, id));
  return !!row && !row.hidden && !row.reported && !row.started && !row.engaged && !row.revised && !row.editedAt
    && now.getTime() >= row.createdAt.getTime() && now.getTime() - row.createdAt.getTime() < EDIT_GRACE_MS;
}

export function historyPath(kind: string, id: number): string { return `/${kind === "topic" ? "t" : "c"}/${id}/history`; }

// A completed appeal releases its evidence; unresolved actions and pending
// appeals keep their referenced source available for adjudication.
const protectedRevision = sql<boolean>`exists (select 1 from moderation_actions action
  where action.revision_id = entry_revisions.id and (
    not exists (select 1 from appeals appeal where appeal.action_id = action.id and appeal.status <> 'open')
    or exists (select 1 from appeals appeal where appeal.action_id = action.id and appeal.status = 'open')
  )) or exists (select 1 from entries evidence
    left join entries topic on topic.id = evidence.thread_id
    where evidence.id = entry_revisions.entry_id and (
      evidence.hidden_at is not null or topic.hidden_at is not null
      or exists (select 1 from moderation_actions action join appeals appeal on appeal.action_id = action.id
        where action.target_entry_id = evidence.id and appeal.status = 'open')
    ))`;

export type HistoryVersion = { id: string; at: string; current: boolean; deleted: boolean; protected: boolean };
export type EntryHistory = {
  id: number; kind: string; threadId: number; owner: boolean; path: string;
  versions: HistoryVersion[];
  selected: (HistoryVersion & { title: string | null; body: string; previous: { title: string | null; body: string } | null }) | null;
};

// Only the selected surviving version and its surviving predecessor leave the
// server. Tombstones and the index never carry original text or mention data.
export function readEntryHistory(db: Db, id: number, viewerId: string | null, version?: string, screen = false): Promise<EntryHistory | null> {
  // One snapshot keeps current text, revision times and tombstones consistent
  // without introducing reader locks into the topic → reply write order.
  return db.transaction(tx => readHistory(tx, id, viewerId, version, screen), { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function readHistory(db: Db, id: number, viewerId: string | null, version: string | undefined, screen: boolean): Promise<EntryHistory | null> {
  const [row] = await db.select({ entry: entries, topic: { authorId: rootTopic.authorId, lang: rootTopic.lang, hiddenAt: rootTopic.hiddenAt } })
    .from(entries).innerJoin(rootTopic, rootTopicOn()).where(and(eq(entries.id, id), isNull(entries.deletedAt), isNull(rootTopic.deletedAt), publicTopicPlace(rootTopic)));
  if (!row) return null;
  const { entry, topic } = row;
  if (entry.hiddenAt || topic.hiddenAt) {
    if (!screen || !viewerId) return null;
    const [account] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, viewerId));
    if (!account) return null;
    const viewer = await getViewer(db, account);
    if (entry.hiddenAt && !canSeeHidden(viewer, entry) || topic.hiddenAt && !canSeeHidden(viewer, topic)) return null;
  }
  const revisions = await db.select({ id: entryRevisions.id, title: entryRevisions.title, body: entryRevisions.body,
    editedAt: entryRevisions.editedAt, deletedAt: entryRevisions.deletedAt, protected: protectedRevision })
    .from(entryRevisions).where(eq(entryRevisions.entryId, id)).orderBy(asc(entryRevisions.id));
  const texts = [...revisions.map(r => ({ title: r.deletedAt ? null : r.title, body: r.deletedAt ? "" : r.body })), { title: entry.title, body: entry.body }];
  const versions: HistoryVersion[] = revisions.map((r, i) => ({ id: String(r.id), at: (i ? revisions[i - 1].editedAt : entry.createdAt).toISOString(),
    current: false, deleted: !!r.deletedAt, protected: entry.authorId === viewerId && r.protected }));
  versions.push({ id: "current", at: (revisions.at(-1)?.editedAt ?? entry.createdAt).toISOString(), current: true, deleted: false, protected: false });
  let selected: EntryHistory["selected"] = null;
  if (version !== undefined) {
    const i = versions.findIndex(v => v.id === version);
    if (i < 0) return null;
    if (!versions[i].deleted) {
      let previous = i - 1;
      while (previous >= 0 && versions[previous].deleted) previous--;
      selected = { ...versions[i], ...texts[i], previous: previous >= 0 ? texts[previous] : null };
    }
  }
  return { id, kind: entry.kind, threadId: entry.threadId ?? id, owner: entry.authorId === viewerId, path: historyPath(entry.kind, id), versions, selected };
}

export type DeleteRevisionError = "not_found" | "forbidden" | "protected";
export async function deleteEntryRevision(db: Db, userId: string, entryId: number, revisionId: number, now = new Date(), expectedKind?: "topic" | "reply"): Promise<{ ok: true } | { ok: false; error: DeleteRevisionError }> {
  return db.transaction(async tx => {
    // Same lock order as edits, fixes and appeal decisions: topic, then reply.
    const [target] = await tx.select({ threadId: entries.threadId }).from(entries).where(eq(entries.id, entryId));
    if (!target) return { ok: false, error: "not_found" } as const;
    if (target.threadId !== null) await tx.select({ id: entries.id }).from(entries).where(eq(entries.id, target.threadId)).for("no key update");
    const [entry] = await tx.select({ kind: entries.kind, authorId: entries.authorId, deletedAt: entries.deletedAt, sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, entryId)).for("no key update");
    if (!entry || entry.deletedAt || expectedKind && entry.kind !== expectedKind) return { ok: false, error: "not_found" } as const;
    if (entry.authorId !== userId) return { ok: false, error: "forbidden" } as const;
    const [revision] = await tx.select({ mentionRevision: entryRevisions.mentionRevision, title: entryRevisions.title, body: entryRevisions.body, protected: protectedRevision }).from(entryRevisions)
      .where(and(eq(entryRevisions.id, revisionId), eq(entryRevisions.entryId, entryId), isNull(entryRevisions.deletedAt))).for("update");
    if (!revision) return { ok: false, error: "not_found" } as const;
    if (revision.protected) return { ok: false, error: "protected" } as const;
    const [snapshot] = await tx.select({ hash: entryMentionSnapshots.sourceHash }).from(entryMentionSnapshots)
      .where(and(eq(entryMentionSnapshots.entryId, entryId), eq(entryMentionSnapshots.revision, revision.mentionRevision)));
    const hash = snapshot?.hash ?? sourceHash(revision.title, revision.body);
    if (hash !== entry.sourceHash) {
      // Signed payloads also contain the source. Keep them only when an extant
      // version still uses that same source, including repeated A → B → A edits.
      const [survivor] = await tx.select({ id: entryRevisions.id }).from(entryRevisions)
        .leftJoin(entryMentionSnapshots, and(eq(entryMentionSnapshots.entryId, entryRevisions.entryId), eq(entryMentionSnapshots.revision, entryRevisions.mentionRevision)))
        .where(and(eq(entryRevisions.entryId, entryId), isNull(entryRevisions.deletedAt), sql`${entryRevisions.id} <> ${revisionId}`,
          sql`(${entryMentionSnapshots.sourceHash} = ${hash} or (${entryMentionSnapshots.sourceHash} is null and ${entryRevisions.title} is not distinct from ${revision.title} and ${entryRevisions.body} = ${revision.body}))`)).limit(1);
      if (!survivor) {
        await tx.delete(memberSignatures).where(and(eq(memberSignatures.entryId, entryId), eq(memberSignatures.sourceHash, hash)));
        await tx.delete(translations).where(and(eq(translations.entryId, entryId), eq(translations.sourceHash, hash)));
        await tx.delete(translationRevisions).where(and(eq(translationRevisions.entryId, entryId), eq(translationRevisions.sourceHash, hash)));
      }
    }
    await tx.update(entryRevisions).set({ title: null, body: "", deletedAt: now }).where(eq(entryRevisions.id, revisionId));
    await tx.delete(entryMentionSnapshots).where(and(eq(entryMentionSnapshots.entryId, entryId), eq(entryMentionSnapshots.revision, revision.mentionRevision)));
    return { ok: true } as const;
  });
}

export async function revisionCounts(db: Db, ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ entryId: entryRevisions.entryId, n: sql<number>`count(*)::int + 1` })
    .from(entryRevisions).where(inArray(entryRevisions.entryId, ids)).groupBy(entryRevisions.entryId);
  return new Map(rows.map(r => [r.entryId, r.n]));
}
