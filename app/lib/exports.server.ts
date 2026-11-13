import { ownPushSubscriptions } from "./push/subscriptions.server";
import { exportVillageIcons } from "./village-icon.server";
import { exportMemberAvatar } from "./member-avatar.server";
import { createHmac, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { readDistributions } from "~/lib/distribution.server";
import { divergences, drafts, entries, entryMentionSnapshots, entryRevisions, follows, savedTopics, memberSignatures, profiles, stanceChanges, stances, translations, villageFollows, villages, votes } from "~/lib/db/schema";
import { publicPostVillageCondition } from "~/lib/villages.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { sourceHash } from "~/lib/source-hash.server";
import type { Area } from "~/lib/languages";
import { sameVendor } from "~/lib/llm/vendor";
import { titleOrNull } from "~/lib/text";
import { exportOwnChat } from "~/lib/village-chat-own.server";
import { entryState, rootTopic, rootTopicOn, visibleWithTopic } from "~/lib/visibility.server";
import {
  aiAssistanceByAreaMonth,
  conformityWarnings,
  divergenceStats,
  diversityByAreaMonth,
  type AiAssistancePoint,
  type ConformityWarning,
  type DivergencePair,
  type DiversityPoint,
} from "~/lib/observation.server";

// Data exports.
// - Observation data (operator /admin/export): entry metadata including question, reply and alternative-framing fields; translation kind, engine, model and fallback; per-entry 「なるほど」 totals and language counts, without per-area counts;
//   distributions for readable questions (only totals and language counts, as members see them); divergence records; diversity metrics. Exclude individual stances, stance-change rows, per-area stance counts and operator-screen metrics such as the directional matrix.
//   Exclude email addresses, user ids and handles. **Pseudonymous, not anonymous**: entry/thread ids and millisecond timestamps are the site's actual values, so a reader of the site can
//   link rows to authors and join exports by entry id. For operator use only; do not share outside operators. Research anonymization requires consent for research use
//   and requires remapped ids, coarse timestamps and suppression of small aggregates. Represent authors with per-export pseudonymous keys: HMAC-SHA256 of user id with a random per-export salt excluded from the export.
//   The same author has the same key within an export; keys cannot link separate exports. Exclude every entry's title and body. Deleted/hidden entries contain only
//   id, kind, thread, source language, creation time and status (deleted/hidden; replies within deleted/hidden topic threads use thread_deleted/thread_hidden),
//   with no author, ai_assistance, insightful, translations or divergences. Exclude divergence notes because they may quote entry text.
// - Member data (/settings/export): own posts and replies (including hidden entries, excluding deleted entries), edit history, drafts, 「なるほど」, current stances and stance-change history. Author translations are no longer supported.
//   Exclude other members' personal data; refer to other authors' entries by id only. Also exclude reactions received by one's own entries and question distributions.

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ---- Observation data ----

export type ObservationEntry =
  | { id: number; kind: string; thread_id: number; lang: string; created_at: string; status: "hidden" | "deleted" | "thread_hidden" | "thread_deleted" }
  | {
      id: number;
      kind: string;
      thread_id: number;
      lang: string;
      author_area: string | null;
      author: string;
      created_at: string;
      edited_at: string | null;
      // null: not stated (posts written on screen state none).
      ai_assistance: string | null;
      via: string;
      // The question marks: asks_stance (a topic that asks for stances), alt_of (the question that this question is another way of asking), stance_tag (the mark on a reply to a question).
      asks_stance: boolean;
      alt_of: number | null;
      stance_tag: string | null;
      status: "visible";
      // "Insightful": the total and from how many languages, per post (what members see in the thread). The count per language area of each post is not exported: with few members in an
      // area it would show who pressed it on which post, and the file can leave the operators' hands. Per-area numbers are kept only as aggregates across posts (the direction matrix of /admin/metrics,
      // for the operators' screen only: it is not in this file either).
      // Members under exclude_reactions are not counted.
      insightful: number;
      insightful_langs: number;
      translations: Array<{ lang: string; field: string; kind: string; engine: string | null; model: string | null; fallback: boolean; flags: string[] }>;
    };

// The format version of the observation export. Tests refer to this constant.
// Version 1: posts with their metadata, translations, divergences, diversity, conformity warnings, AI-assistance by month.
// Version 2: the question marks on each post (asks_stance, alt_of, stance_tag); the Insightful of each post as a total and a number of languages (insightful, insightful_langs; the
// per-area votes_by_area of version 1 is gone); the questions section (each readable question with its distribution as members see it: total, counts, langs, as_of); ai_assistance may be null
// on a post (not stated: a post written on the screen states nothing), and the `total` of the ai_assistance array (by area and month) counts only the posts that state a value; the number
// of posts without one is not in the file (the operators' screen shows it).
// Never in the file: stance change rows, who chose which stance, per-area stance numbers, and the metrics of the operators' screen.
export const OBSERVATION_EXPORT_VERSION = 2;

export type ObservationExport = {
  format: "tomola-observation-export";
  version: typeof OBSERVATION_EXPORT_VERSION;
  generated_at: string;
  embedding_model: string | null;
  author_key: { algorithm: string; note: string };
  entries: ObservationEntry[];
  // Distributions per readable question (neither deleted nor hidden): the display shape from readDistributions, only totals and language counts. Exclude question-by-area counts, stance-change rows and individual stances.
  // Do not count reactions-excluded members' stances.
  questions: Array<{ id: number; alt_of: number | null; created_at: string; distribution: { total: number; counts: { agree: number; disagree: number; neither: number }; langs: number; as_of: string } }>;
  divergences: Array<{
    entry_id: number;
    lang: string;
    segment_idx: number;
    severity: string;
    category: string;
    judge_engine: string | null;
    judge_model: string | null;
    primary_engine: string | null;
    primary_model: string | null;
    secondary_engine: string | null;
    secondary_model: string | null;
    same_vendor: boolean | null;
  }>;
  divergence_summary: DivergencePair[];
  diversity: Array<{ area: Area; month: string; entries: number; mean_distance: number }>;
  conformity_warnings: ConformityWarning[];
  ai_assistance: Array<{ area: Area; month: string; counts: AiAssistancePoint["counts"]; total: number; declared_share: number | null }>;
};

export const AUTHOR_KEY_LENGTH = 16;

// Author pseudonym: first AUTHOR_KEY_LENGTH hexadecimal characters of HMAC-SHA256(user id), keyed by a random per-export salt.
export function authorKeyOf(userId: string, salt: Buffer): string {
  return createHmac("sha256", salt).update(userId).digest("hex").slice(0, AUTHOR_KEY_LENGTH);
}

export async function buildObservationExport(
  db: Db,
  opts: { model: string | null; now?: Date; salt?: Buffer },
): Promise<ObservationExport> {
  const now = opts.now ?? new Date();
  const salt = opts.salt ?? randomBytes(32);
  const rows = await db
    .select({
      id: entries.id,
      kind: entries.kind,
      threadId: entries.threadId,
      lang: entries.lang,
      authorId: entries.authorId,
      authorArea: entries.authorArea,
      aiAssistance: entries.aiAssistance,
      via: entries.via,
      asksStance: entries.asksStance,
      altOf: entries.altOf,
      stanceTag: entries.stanceTag,
      createdAt: entries.createdAt,
      editedAt: entries.editedAt,
      deletedAt: entries.deletedAt,
      hiddenAt: entries.hiddenAt,
      topicDeletedAt: rootTopic.deletedAt,
      topicHiddenAt: rootTopic.hiddenAt,
    })
    .from(entries)
    .innerJoin(rootTopic, rootTopicOn())
    .orderBy(asc(entries.id));
  const secondary = alias(translations, "secondary");
  const primary = alias(translations, "primary");
  const [voteRows, translationRows, divergenceRows, divergence_summary, diversity, ai] = await Promise.all([
    // The query counts per area, and the rows are folded into the total and the number of areas below: the per-area counts do not reach the export.
    db
      .select({ entryId: votes.entryId, area: votes.voterArea, n: sql<number>`count(*)::int` })
      .from(votes)
      .innerJoin(entries, eq(entries.id, votes.entryId))
      .innerJoin(rootTopic, rootTopicOn())
      .innerJoin(profiles, and(eq(profiles.userId, votes.voterId), isNull(profiles.reactionsExcludedAt)))
      .where(visibleWithTopic())
      .groupBy(votes.entryId, votes.voterArea),
    db
      .select({
        entryId: translations.entryId,
        lang: translations.lang,
        field: translations.field,
        kind: translations.kind,
        engine: translations.engine,
        model: translations.model,
        fallback: translations.fallback,
        flags: translations.flags,
      })
      .from(translations)
      .innerJoin(entries, eq(entries.id, translations.entryId))
      .innerJoin(rootTopic, rootTopicOn())
      .where(visibleWithTopic())
      .orderBy(asc(translations.entryId), asc(translations.lang), asc(translations.field), asc(translations.kind)),
    db
      .select({
        entryId: divergences.entryId,
        lang: divergences.lang,
        segmentIdx: divergences.segmentIdx,
        severity: divergences.severity,
        category: divergences.category,
        judgeEngine: divergences.judgeEngine,
        judgeModel: divergences.judgeModel,
        primaryEngine: primary.engine,
        primaryModel: primary.model,
        secondaryEngine: secondary.engine,
        secondaryModel: secondary.model,
      })
      .from(divergences)
      .innerJoin(entries, eq(entries.id, divergences.entryId))
      .innerJoin(rootTopic, rootTopicOn())
      .leftJoin(primary, and(eq(primary.entryId, divergences.entryId), eq(primary.lang, divergences.lang), eq(primary.field, "body"), eq(primary.kind, "primary")))
      .leftJoin(secondary, and(eq(secondary.entryId, divergences.entryId), eq(secondary.lang, divergences.lang), eq(secondary.field, "body"), eq(secondary.kind, "secondary")))
      .where(visibleWithTopic())
      .orderBy(asc(divergences.entryId), asc(divergences.lang), asc(divergences.segmentIdx)),
    divergenceStats(db),
    opts.model ? diversityByAreaMonth(db, { model: opts.model, now }) : Promise.resolve<DiversityPoint[]>([]),
    aiAssistanceByAreaMonth(db, { now }),
  ]);

  const insightfulOf = new Map<number, { total: number; langs: number }>();
  for (const v of voteRows) {
    const soFar = insightfulOf.get(v.entryId) ?? { total: 0, langs: 0 };
    insightfulOf.set(v.entryId, { total: soFar.total + Number(v.n), langs: soFar.langs + 1 });
  }
  const translationsOf = new Map<number, Array<{ lang: string; field: string; kind: string; engine: string | null; model: string | null; fallback: boolean; flags: string[] }>>();
  for (const t of translationRows) {
    const list = translationsOf.get(t.entryId) ?? [];
    list.push({ lang: t.lang, field: t.field, kind: t.kind, engine: t.engine, model: t.model, fallback: t.fallback, flags: t.flags });
    translationsOf.set(t.entryId, list);
  }

  const questionRows = await db
    .select({ id: entries.id, altOf: entries.altOf, createdAt: entries.createdAt })
    .from(entries)
    .where(and(eq(entries.kind, "topic"), eq(entries.asksStance, true), isNull(entries.deletedAt), isNull(entries.hiddenAt)))
    .orderBy(asc(entries.id));
  const distributionOf = await readDistributions(db, questionRows.map((q) => q.id), { kind: "observation" }, { now });

  const exported: ObservationEntry[] = rows.map((r): ObservationEntry => {
    const threadId = r.threadId ?? r.id;
    // A post that cannot be read gets metadata only (no author key, ai_assistance, via, question marks, votes or translations). The state is the post's own first, then its thread's topic.
    const state = entryState(r);
    if (state !== "visible") return { id: r.id, kind: r.kind, thread_id: threadId, lang: r.lang, created_at: r.createdAt.toISOString(), status: state };
    return {
      id: r.id,
      kind: r.kind,
      thread_id: threadId,
      lang: r.lang,
      author_area: r.authorArea,
      author: authorKeyOf(r.authorId, salt),
      created_at: r.createdAt.toISOString(),
      edited_at: iso(r.editedAt),
      ai_assistance: r.aiAssistance,
      via: r.via,
      asks_stance: r.asksStance,
      alt_of: r.altOf,
      stance_tag: r.stanceTag,
      status: "visible",
      insightful: insightfulOf.get(r.id)?.total ?? 0,
      insightful_langs: insightfulOf.get(r.id)?.langs ?? 0,
      translations: translationsOf.get(r.id) ?? [],
    };
  });

  return {
    format: "tomola-observation-export",
    version: OBSERVATION_EXPORT_VERSION,
    generated_at: now.toISOString(),
    embedding_model: opts.model,
    author_key: {
      algorithm: `HMAC-SHA256(user id, a random salt generated for this export), hex, first ${AUTHOR_KEY_LENGTH} characters`,
      note: "Pseudonymous, NOT anonymous. The same author has the same key within this export only (the salt is not stored), but entry and thread ids and millisecond timestamps are the forum's own: anyone who can read the forum can map rows back to authors and can link exports to each other by entry id. For operator use only; do not hand this file to anyone outside the operators.",
    },
    entries: exported,
    questions: questionRows.map((q) => {
      const d = distributionOf.get(q.id);
      return {
        id: q.id,
        alt_of: q.altOf,
        created_at: q.createdAt.toISOString(),
        distribution: { total: d?.total ?? 0, counts: { agree: d?.counts.agree ?? 0, disagree: d?.counts.disagree ?? 0, neither: d?.counts.neither ?? 0 }, langs: d?.langs ?? 0, as_of: now.toISOString() },
      };
    }),
    divergences: divergenceRows.map((d) => ({
      entry_id: d.entryId,
      lang: d.lang,
      segment_idx: d.segmentIdx,
      severity: d.severity,
      category: d.category,
      judge_engine: d.judgeEngine,
      judge_model: d.judgeModel,
      primary_engine: d.primaryEngine,
      primary_model: d.primaryModel,
      secondary_engine: d.secondaryEngine,
      secondary_model: d.secondaryModel,
      same_vendor: sameVendor(d.primaryEngine, d.secondaryEngine),
    })),
    divergence_summary,
    diversity: diversity.map((p) => ({ area: p.area, month: p.month, entries: p.entries, mean_distance: p.meanDistance })),
    conformity_warnings: conformityWarnings(diversity, now),
    ai_assistance: ai.map((p) => ({ area: p.area, month: p.month, counts: p.counts, total: p.total, declared_share: p.declaredShare })),
  };
}

// ---- Member data ----

// The format version of the member export. Every merge that adds or removes a field adds 1 to the value on main; tests refer to this constant.
// Version 2: the author-translation keys (author_translations, author_translation_revisions) were removed.
// Version 3: profile.write_langs was removed ("writable languages" are gone).
// Version 4: `follows` was added.
// Version 5: votes became insightful (the member's own Insightful: entry_id, voter_area, created_at); the member's own stances (stances) and the history of changes of them
// (stance_changes) were added; entries and drafts carry asks_stance, alt_of and stance_tag; ai_assistance may be null on a post and a draft (not stated: the AI-assistance field left the screens,
// the key stays, the value is null).
// Still only the member's own rows: no one else's stance, no count of the Insightful that the member's posts received, no distribution of a question.
// Version 6: signed acceptance evidence and its links to the current and historical source versions; draft version numbers.
// Version 7 includes the member's selected introduction topic.
// Version 8 includes the member's undeleted chat messages; empty while chat is disabled.
// Version 9 includes the villages the member follows (village_follows).
// Version 10 includes both optional display names.
// Version 11 includes the member's current uploaded avatar, with its rewritten bytes.
// Version 12 includes residence and participation/stance consent records.
// Version 13 includes current uploaded icons of villages the member owns.
// Version 14 includes the member's private saved topic IDs and save times.
// Version 15 includes notification registration counts, coarse labels and dates.
// Version 16 includes the member's saved appearance.
export const MEMBER_EXPORT_VERSION = 16;

export type MemberExport = {
  format: "tomola-member-export";
  push_subscriptions: { count: number; registrations: { browser: string; os: string; registered_at: string }[] };
  version: typeof MEMBER_EXPORT_VERSION;
  generated_at: string;
  profile: {
    handle: string;
    display_name: string | null;
    display_name_latin: string | null;
    avatar: Awaited<ReturnType<typeof exportMemberAvatar>>;
    intro_entry_id: number | null;
    home_area: string;
    read_langs: string[];
    display_lang: string | null;
    email_pref: string;
    ui_locale: string | null;
    color_scheme: string | null;
    sign_posts: boolean;
    residence_country: string | null;
    adult_confirmed_at: string | null;
    trial_consent_version: number | null;
    trial_consent_at: string | null;
    stance_consent_version: number | null;
    stance_consent_at: string | null;
    created_at: string;
  } | null;
  // Own posts/replies, excluding deleted entries but including hidden ones with status hidden.
  entries: Array<{
    id: number;
    kind: string;
    thread_id: number;
    parent_id: number | null;
    lang: string;
    title: string | null;
    body: string;
    // null: not stated (posts written on screen state none).
    ai_assistance: string | null;
    via: string;
    asks_stance: boolean;
    alt_of: number | null;
    stance_tag: string | null;
    author_area: string | null;
    created_at: string;
    edited_at: string | null;
    status: "visible" | "hidden";
    signature_ids: number[];
    // Previous revisions replaced by edits.
    revisions: Array<{ title: string | null; body: string; edited_at: string; deleted_at: string | null; signature_ids: number[] }>;
  }>;
  drafts: Array<{
    id: number;
    version: number;
    kind: string;
    thread_id: number | null;
    parent_id: number | null;
    lang: string;
    title: string | null;
    body: string;
    // null: not stated (posts written on screen state none).
    ai_assistance: string | null;
    via: string;
    asks_stance: boolean;
    alt_of: number | null;
    stance_tag: string | null;
    raw_frontmatter: string | null;
    created_at: string;
    updated_at: string;
  }>;
  // The member's own Insightful: only the post's id, never its author. voter_area is the member's area when they pressed it.
  insightful: Array<{ entry_id: number; voter_area: string; created_at: string }>;
  // The member's current stance on each question (withdrawn stances have no row). area is their current area.
  stances: Array<{ question_id: number; position: string; area: string; version: number; created_at: string; updated_at: string }>;
  // The member's append-only stance history. A null from_position is the first choice, a null to_position a withdrawal; trigger_entry_id is the prompting post, or null.
  stance_changes: Array<{
    question_id: number;
    from_position: string | null;
    to_position: string | null;
    trigger_entry_id: number | null;
    trigger_area: string | null;
    area: string;
    created_at: string;
  }>;
  // The member's saved topics: only the topic's id and when it was saved, without content or other members' information.
  saved_topics: Array<{ topic_id: number; created_at: string }>;
  // The member's own follows (both states: `unfollowed` is the record that stops the automatic follow). Only the topic's id, never anything about the topic or other members.
  follows: Array<{ thread_id: number; state: string; created_at: string; updated_at: string }>;
  // The villages the member follows: only the village selector (slug or @handle) and when the member began to follow it. A village that is not public any more is not listed.
  village_icons: Awaited<ReturnType<typeof exportVillageIcons>>;
  village_follows: Array<{ village: string; created_at: string }>;
  signatures: Array<{ id: number; entry_id: number | null; source_hash: string | null; operation: string; signed_payload: string; payload_hash: string; challenge: string; credential_id: string; public_key: string; rp_id: string; origin: string; assertion: Record<string, unknown>; authenticator_data: string; client_data_json: string; signature: string; created_at: string }>;
  chat_messages: Awaited<ReturnType<typeof exportOwnChat>>;
};

// The villages the member follows, read in two steps so that a member who follows none (or while villages are closed) never makes a read of the villages table.
async function exportVillageFollows(db: Db, userId: string): Promise<MemberExport["village_follows"]> {
  if (!villagesEnabled()) return [];
  const followed = await db.select({ villageId: villageFollows.villageId, createdAt: villageFollows.createdAt }).from(villageFollows)
    .where(eq(villageFollows.userId, userId)).orderBy(asc(villageFollows.createdAt), asc(villageFollows.villageId));
  if (followed.length === 0) return [];
  const known = await db.select({ id: villages.id, slug: sql<string | null>`case when ${villages.kind} = 'personal' then '@' || ${profiles.handle} else ${villages.slug} end` }).from(villages).leftJoin(profiles, eq(profiles.userId, villages.ownerId))
    .where(and(inArray(villages.id, followed.map(row => row.villageId)), publicPostVillageCondition()));
  const slugs = new Map(known.map(row => [row.id, row.slug]));
  return followed.flatMap(row => {
    const slug = slugs.get(row.villageId);
    return slug ? [{ village: slug, created_at: row.createdAt.toISOString() }] : [];
  });
}

export async function buildMemberExport(db: Db, userId: string, opts: { now?: Date } = {}): Promise<MemberExport> {
  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId));
  const own = await db
    .select()
    .from(entries)
    .where(and(eq(entries.authorId, userId), isNull(entries.deletedAt)))
    .orderBy(asc(entries.createdAt), asc(entries.id));
  const ownIds = own.map((e) => e.id);
  const [revisionRows, draftRows, voteRows, stanceRows, changeRows, followRows, villageFollowRows, signatureRows, savedRows] = await Promise.all([
    ownIds.length === 0
      ? Promise.resolve([])
      : db.select({ revision: entryRevisions, sourceHash: entryMentionSnapshots.sourceHash }).from(entryRevisions)
          .leftJoin(entryMentionSnapshots, and(eq(entryMentionSnapshots.entryId, entryRevisions.entryId), eq(entryMentionSnapshots.revision, entryRevisions.mentionRevision)))
          .where(inArray(entryRevisions.entryId, ownIds)).orderBy(asc(entryRevisions.entryId), asc(entryRevisions.id)),
    db.select().from(drafts).where(eq(drafts.authorId, userId)).orderBy(asc(drafts.id)),
    db.select().from(votes).where(eq(votes.voterId, userId)).orderBy(asc(votes.createdAt), asc(votes.entryId)),
    // Own rows only (where the member is the user): nobody else's stance is read here.
    db.select().from(stances).where(eq(stances.userId, userId)).orderBy(asc(stances.createdAt), asc(stances.questionId)),
    db.select().from(stanceChanges).where(eq(stanceChanges.userId, userId)).orderBy(asc(stanceChanges.createdAt), asc(stanceChanges.id)),
    db.select().from(follows).where(eq(follows.userId, userId)).orderBy(asc(follows.createdAt), asc(follows.threadId)),
    exportVillageFollows(db, userId),
    db.select({ signature: memberSignatures }).from(memberSignatures).leftJoin(entries, eq(entries.id, memberSignatures.entryId))
      .where(and(eq(memberSignatures.userId, userId), or(isNull(memberSignatures.entryId), isNull(entries.deletedAt))))
      .orderBy(asc(memberSignatures.createdAt), asc(memberSignatures.id)),
    db.select({ topicId: savedTopics.topicId, createdAt: savedTopics.createdAt }).from(savedTopics).where(eq(savedTopics.userId, userId)).orderBy(asc(savedTopics.createdAt), asc(savedTopics.topicId)),
  ]);
  const signaturesFor = (entryId: number, hash: string) => signatureRows.filter(r => r.signature.entryId === entryId && r.signature.sourceHash === hash).map(r => r.signature.id);
  const revisionsOf = new Map<number, MemberExport["entries"][number]["revisions"]>();
  for (const { revision: r, sourceHash: savedHash } of revisionRows) {
    const list = revisionsOf.get(r.entryId) ?? [];
    list.push({ title: r.title, body: r.body, edited_at: r.editedAt.toISOString(), deleted_at: r.deletedAt?.toISOString() ?? null, signature_ids: r.deletedAt ? [] : signaturesFor(r.entryId, savedHash ?? sourceHash(r.title, r.body)) });
    revisionsOf.set(r.entryId, list);
  }
  const pushRows = await ownPushSubscriptions(db, userId);
  return {
    format: "tomola-member-export",
    push_subscriptions: { count: pushRows.length, registrations: pushRows.map(row => ({ browser: row.browser, os: row.os, registered_at: row.createdAt.toISOString() })) },
    version: MEMBER_EXPORT_VERSION,
    generated_at: (opts.now ?? new Date()).toISOString(),
    profile: profile
      ? {
          handle: profile.handle,
          display_name: profile.displayName,
          display_name_latin: profile.displayNameLatin,
          avatar: await exportMemberAvatar(db, userId),
          intro_entry_id: profile.introEntryId,
          home_area: profile.homeArea,
          read_langs: profile.readLangs,
          display_lang: profile.displayLang,
          email_pref: profile.emailPref,
          ui_locale: profile.uiLocale,
          color_scheme: profile.colorScheme,
          sign_posts: profile.signPosts,
          residence_country: profile.residenceCountry,
          adult_confirmed_at: iso(profile.adultConfirmedAt),
          trial_consent_version: profile.trialConsentVersion,
          trial_consent_at: iso(profile.trialConsentAt),
          stance_consent_version: profile.stanceConsentVersion,
          stance_consent_at: iso(profile.stanceConsentAt),
          created_at: profile.createdAt.toISOString(),
        }
      : null,
    entries: own.map((e) => ({
      id: e.id,
      kind: e.kind,
      thread_id: e.threadId ?? e.id,
      parent_id: e.parentId,
      lang: e.lang,
      title: e.title,
      body: e.body,
      ai_assistance: e.aiAssistance,
      via: e.via,
      asks_stance: e.asksStance,
      alt_of: e.altOf,
      stance_tag: e.stanceTag,
      author_area: e.authorArea,
      created_at: e.createdAt.toISOString(),
      edited_at: iso(e.editedAt),
      status: e.hiddenAt !== null ? "hidden" : "visible",
      signature_ids: signaturesFor(e.id, e.sourceHash ?? sourceHash(e.title, e.body)),
      revisions: revisionsOf.get(e.id) ?? [],
    })),
    drafts: draftRows.map((d) => ({
      id: d.id,
      version: d.version,
      kind: d.kind,
      thread_id: d.threadId,
      parent_id: d.parentId,
      lang: d.lang,
      // A draft row may hold "" or whitespace from before the title was normalized: that is "no title" (null).
      title: titleOrNull(d.title),
      body: d.body,
      ai_assistance: d.aiAssistance,
      via: d.via,
      asks_stance: d.asksStance,
      alt_of: d.altOf,
      stance_tag: d.stanceTag,
      raw_frontmatter: d.rawFrontmatter,
      created_at: d.createdAt.toISOString(),
      updated_at: d.updatedAt.toISOString(),
    })),
    insightful: voteRows.map((v) => ({ entry_id: v.entryId, voter_area: v.voterArea, created_at: v.createdAt.toISOString() })),
    stances: stanceRows.map((r) => ({ question_id: r.questionId, position: r.position, area: r.area, version: r.version, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString() })),
    stance_changes: changeRows.map((r) => ({
      question_id: r.questionId,
      from_position: r.fromPosition,
      to_position: r.toPosition,
      trigger_entry_id: r.triggerEntryId,
      trigger_area: r.triggerArea,
      area: r.area,
      created_at: r.createdAt.toISOString(),
    })),
    saved_topics: savedRows.map(row => ({ topic_id: row.topicId, created_at: row.createdAt.toISOString() })),
    follows: followRows.map((f) => ({ thread_id: f.threadId, state: f.state, created_at: f.createdAt.toISOString(), updated_at: f.updatedAt.toISOString() })),
    village_icons: await exportVillageIcons(db, userId),
    village_follows: villageFollowRows,
    signatures: signatureRows.map(({ signature: s }) => ({ id: s.id, entry_id: s.entryId, source_hash: s.sourceHash, operation: s.operation, signed_payload: s.payload, payload_hash: s.payloadHash, challenge: s.challenge, credential_id: s.credentialId, public_key: s.publicKey, rp_id: s.rpId, origin: s.origin, assertion: s.assertion, authenticator_data: s.authenticatorData, client_data_json: s.clientDataJson, signature: s.signature, created_at: s.createdAt.toISOString() })),
    chat_messages: await exportOwnChat(db, userId),
  };
}
