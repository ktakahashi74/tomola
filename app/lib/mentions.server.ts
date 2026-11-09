import { withMarkdownPersistedRead } from "./markdown-budget.server";
import { withMarkdownRead } from "./markdown-budget.server";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, entryMentionSnapshots, entryRevisions, profiles, type SavedMentionBinding } from "~/lib/db/schema";
import { handleKey } from "~/lib/handles";
import { tokenPrefixes } from "~/lib/mention-syntax";
import { frozenMentionKey, matchMentions, mentionSpellings, mentionTokens, splitMentions, type MentionTarget, type MentionTargets } from "~/lib/mentions-md.server";
import { sourceHash } from "~/lib/source-hash.server";

// The members that the mentions in some Markdown bodies can name: one query for all the bodies. Every prefix of every candidate run (2 to 30 characters) is
// turned into its handle_key and looked up; the longest prefix that is a member decides (mentions-md.server.ts). A body without a sigil costs no query.
// There is no rule about who may be named: a suspended member is named like anyone else, a member that does not exist is not in the map.
// The keys of one query are cut into chunks of this size (50 candidates x 29 prefixes is at most 1,450 for one body).
const KEYS_PER_QUERY = 2000;

export async function resolveMentionTargets(db: Db, markdown: string | readonly string[]): Promise<MentionTargets> {
  const bodies = typeof markdown === "string" ? [markdown] : markdown;
  const keys = new Set<string>();
  for (const body of bodies) {
    for (const token of (await mentionTokens(body))) for (const prefix of tokenPrefixes(token)) keys.add(handleKey(prefix));
  }
  const out = new Map<string, MentionTarget>();
  const all = [...keys];
  for (let i = 0; i < all.length; i += KEYS_PER_QUERY) {
    const rows = await db
      .select({ key: profiles.handleKey, handle: profiles.handle, userId: profiles.userId, publicId: profiles.publicId })
      .from(profiles)
      .where(inArray(profiles.handleKey, all.slice(i, i + KEYS_PER_QUERY)));
    for (const row of rows) out.set(row.key, { handle: row.handle, userId: row.userId, publicId: row.publicId });
  }
  return out;
}

// For a translation of `source`: the targets to render the translation with (only the members that the source names), and the mentions of the source as written
// ("@hana"; the quoted ones too: they are shown as mentions), which the translation must keep (TranslationRequest.mentions).
export async function resolveSourceMentions(db: Db, source: string, entryId?: number): Promise<{ targets: MentionTargets; mentions: string[]; mentionRevision?: number }> {
  if (entryId !== undefined) {
    const saved = (await resolveSourceSnapshotsFor(db, [entryId])).get(entryId);
    const targets = saved?.source === source ? saved.mentions : new Map();
    return { targets, mentions: (await withMarkdownRead(() => matchMentions(source, targets))).map(m => m.text), mentionRevision: saved?.mentionRevision };
  }
  // Unsaved previews and parser utilities may resolve current names. Stored entries always pass entryId.
  const found = (await matchMentions(source, await resolveMentionTargets(db, source)));
  return { targets: new Map(found.map(m => [m.key, { handle: m.handle, userId: m.userId, publicId: m.publicId }])), mentions: found.map(m => m.text) };
}

export type SourceMentionSnapshot = { entryId: number; source: string; sourceHash: string | null; mentionRevision: number; mentions: MentionTargets };

export async function readMentionBindings(db: Db, entryId: number, revision: number): Promise<SavedMentionBinding[]> {
  const [row] = await db.select({ bindings: entryMentionSnapshots.bindings }).from(entryMentionSnapshots)
    .where(and(eq(entryMentionSnapshots.entryId, entryId), eq(entryMentionSnapshots.revision, revision)));
  return row?.bindings ?? [];
}

// Call inside the source write transaction. Keep each exact spelling, including a failed resolution.
async function bindMentionSpellingsImplementation(db: Db, body: string, previous: readonly SavedMentionBinding[] = []): Promise<SavedMentionBinding[]> {
  // Resolution reads one namespace snapshot; it does not claim a name or need its exclusive claim lock.
  const prior = new Map(previous.map(binding => [binding.spelling, binding]));
  const spellings = (await mentionSpellings(body));
  const fresh = spellings.filter(spelling => !prior.has(spelling));
  const live = await resolveMentionTargets(db, fresh.join(" "));
  return spellings.map(spelling => {
    const inherited = prior.get(spelling);
    if (inherited) return inherited;
    const match = splitMentions(spelling, live).find(piece => typeof piece !== "string");
    return { spelling, prefix: match ? match.text.slice(1) : null, userId: match?.userId ?? null };
  });
}

export async function resolveTranslationMentionsFor(db: Db, rows: readonly { id: number; entryId: number; sourceHash: string | null; mentionRevision: number | null }[]): Promise<Map<number, MentionTargets>> {
  const out = new Map<number, MentionTargets>();
  if (!rows.length) return out;
  const snapshots = await db.select().from(entryMentionSnapshots).where(inArray(entryMentionSnapshots.entryId, rows.map(row => row.entryId)));
  for (const row of rows) {
    const candidates = snapshots.filter(saved => saved.entryId === row.entryId && (row.mentionRevision === null ? saved.sourceHash === row.sourceHash : saved.revision === row.mentionRevision));
    const saved = candidates.sort((a, b) => b.revision - a.revision)[0];
    out.set(row.id, await targetsForBindings(db, saved?.bindings ?? []));
  }
  return out;
}

export async function targetsForBindings(db: Db, bindings: readonly SavedMentionBinding[]): Promise<MentionTargets> {
  const ids = [...new Set(bindings.flatMap(binding => binding.userId === null ? [] : [binding.userId]))];
  const people = ids.length ? await db.select({ userId: profiles.userId, publicId: profiles.publicId }).from(profiles).where(inArray(profiles.userId, ids)) : [];
  const byId = new Map(people.map(person => [person.userId, person.publicId]));
  const targets = new Map<string, MentionTarget>();
  const normalized = new Map<string, MentionTarget | null>();
  for (const binding of bindings) {
    const target: MentionTarget = { handle: binding.prefix ? handleKey(binding.prefix) : "", userId: binding.userId ?? "", prefix: binding.prefix,
      ...(binding.userId && byId.has(binding.userId) ? { publicId: byId.get(binding.userId)! } : {}) };
    targets.set(frozenMentionKey(binding.spelling), target);
    if (binding.prefix && binding.userId) {
      const key = handleKey(binding.prefix);
      const old = normalized.get(key);
      normalized.set(key, normalized.has(key) && old?.userId !== target.userId ? null : target);
    }
  }
  // Translations may normalize width/case. Resolve that variation only when its source destination is unambiguous.
  for (const [key, target] of normalized) if (target) targets.set(key, target);
  return targets;
}

export async function storeMentionSnapshot(db: Db, input: { entryId: number; revision: number; sourceHash: string | null; body: string; bindings: SavedMentionBinding[] }): Promise<MentionTargets> {
  await db.insert(entryMentionSnapshots).values(input);
  return targetsForBindings(db, input.bindings);
}

export async function resolveSavedMentionsFor(db: Db, rows: readonly { id: number; mentionRevision: number }[]): Promise<Map<number, MentionTargets>> {
  const out = new Map<number, MentionTargets>();
  if (!rows.length) return out;
  const snapshots = await db.select().from(entryMentionSnapshots).where(inArray(entryMentionSnapshots.entryId, rows.map(row => row.id)));
  for (const row of rows) {
    const saved = snapshots.find(snapshot => snapshot.entryId === row.id && snapshot.revision === row.mentionRevision);
    out.set(row.id, await targetsForBindings(db, saved?.bindings ?? []));
  }
  return out;
}

// Read the source snapshot with its targets, so a translation cache save can reject an overlapping source edit.
export async function resolveSourceSnapshotsFor(db: Db, entryIds: readonly number[]): Promise<Map<number, SourceMentionSnapshot>> {
  const out = new Map<number, SourceMentionSnapshot>();
  if (entryIds.length === 0) return out;
  const rows = await db.select({ id: entries.id, body: entries.body, sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision, bindings: entryMentionSnapshots.bindings })
    .from(entries).leftJoin(entryMentionSnapshots, and(eq(entryMentionSnapshots.entryId, entries.id), eq(entryMentionSnapshots.revision, entries.mentionRevision)))
    .where(inArray(entries.id, [...entryIds]));
  for (const row of rows) out.set(row.id, { entryId: row.id, source: row.body, sourceHash: row.sourceHash, mentionRevision: row.mentionRevision, mentions: await targetsForBindings(db, row.bindings ?? []) });
  return out;
}

// Run while applying migrations, before serving writes. Restarting is idempotent; already frozen revisions never resolve again.
async function backfillMentionSnapshotsImplementation(db: Db): Promise<number> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(2026100301)`);
    const current = await tx.select({ entryId: entries.id, revision: entries.mentionRevision, body: entries.body, sourceHash: entries.sourceHash }).from(entries);
    const old = await tx.select({ entryId: entryRevisions.entryId, revision: entryRevisions.mentionRevision, body: entryRevisions.body, title: entryRevisions.title }).from(entryRevisions);
    let n = 0;
    for (const row of [...current, ...old.map(row => ({ ...row, sourceHash: sourceHash(row.title, row.body) }))]) {
      const [exists] = await tx.select({ revision: entryMentionSnapshots.revision }).from(entryMentionSnapshots).where(and(eq(entryMentionSnapshots.entryId, row.entryId), eq(entryMentionSnapshots.revision, row.revision)));
      if (exists) continue;
      await storeMentionSnapshot(tx, { entryId: row.entryId, revision: row.revision, sourceHash: row.sourceHash, body: row.body, bindings: await bindMentionSpellings(tx, row.body) });
      n++;
    }
    return n;
  });
}

export function bindMentionSpellings(...args: Parameters<typeof bindMentionSpellingsImplementation>): ReturnType<typeof bindMentionSpellingsImplementation> {
  return withMarkdownPersistedRead(() => bindMentionSpellingsImplementation(...args));
}

export function backfillMentionSnapshots(...args: Parameters<typeof backfillMentionSnapshotsImplementation>): ReturnType<typeof backfillMentionSnapshotsImplementation> {
  return withMarkdownPersistedRead(() => backfillMentionSnapshotsImplementation(...args));
}
