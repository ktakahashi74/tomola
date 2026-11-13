import { TRANSLATION_REPORT_OUTCOMES } from "../translation-report-results";
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  vector,
  type AnyPgColumn,
  type PgColumn,
} from "drizzle-orm/pg-core";
import { AI_ASSISTANCE } from "../ai-assistance";
import { GLOSSARY_VIAS, type GlossaryContent } from "../glossary";
import { AREAS, LANGS, SOURCE_LANGS, type SourceLang, type Lang } from "../languages";
import { APPEAL_STATUSES, CHAT_ACTIONS, ENTRY_ACTIONS, MEMBER_ACTIONS, MODERATION_ACTIONS, REPORT_REASONS, REPORT_STATUSES, VILLAGE_ACTIONS } from "../moderation";
import { FOLLOW_STATES } from "../follows";
import { DEFAULT_EMAIL_PREF, EMAIL_PREFS, NOTIFICATION_KINDS } from "../notifications";
import { POSITIONS, STANCE_TAGS } from "../stances";
import type { ReasonPick } from "../reasons";
import { user } from "./auth-schema";
import { VILLAGE_INVITE_KINDS, VILLAGE_INVITE_STATES } from "../villages";

import { READING_METHODS, READING_SOURCES } from "../reading-sources.server";

export * from "./auth-schema";
export * from "./oauth-schema";

// Keep the singleton even when inactive: its row lock serializes holds with cleanup.
export const retentionHold = pgTable("retention_hold", {
  id: integer("id").primaryKey(),
  active: boolean("active").notNull().default(false),
  reason: text("reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("retention_hold_singleton_check", sql`${t.id} = 1`)]);

// Retryable operator work. Completion clears direct account identifiers.
export const accountDeletions = pgTable("account_deletions", {
  id: text("id").primaryKey(),
  completionKey: text("completion_key").unique(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  confirmation: text("confirmation"),
  posts: text("posts").notNull().default("keep"),
  villageDecisions: jsonb("village_decisions").$type<Record<string, string>>().notNull().default({}),
  state: text("state").notNull().default("pending"),
  noticeState: text("notice_state").notNull().default("none"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [
  check("account_deletions_posts_check", oneOf(t.posts, ["keep", "delete"])),
  check("account_deletions_state_check", oneOf(t.state, ["pending", "failed", "completed", "cancelled"])),
  check("account_deletions_notice_check", oneOf(t.noticeState, ["none", "pending", "sent", "failed"])),
  uniqueIndex("account_deletions_pending_user_idx").on(t.userId).where(sql`${t.state} in ('pending', 'failed')`),
]);

export const suspendedEmailHashes = pgTable("suspended_email_hashes", {
  hash: text("hash").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, t => [index("suspended_email_hashes_expiry_idx").on(t.expiresAt)]);

const binary = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: value => value,
  fromDriver: value => Buffer.from(value),
});
export const media = pgTable("media", {
  id: text("id").primaryKey(),
  bytes: binary("bytes"),
  avatar: boolean("avatar").notNull().default(false),
  villageId: text("village_id").references((): AnyPgColumn => villages.id, { onDelete: "cascade" }),
  mime: text("mime").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  byteSize: integer("byte_size").notNull(),
  uploadedBy: text("uploaded_by").notNull().references(() => user.id),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, t => [
  index("media_uploaded_by_idx").on(t.uploadedBy),
  index("media_active_bytes_idx").on(t.uploadedBy, t.byteSize).where(sql`${t.deletedAt} is null`),
  check("media_id_check", sql`${t.id} ~ '^[a-f0-9]{64}$'`),
  check("media_mime_check", sql`${t.mime} = 'image/webp'`),
  check("media_dimensions_check", sql`${t.width} BETWEEN 1 AND 2000 AND ${t.height} BETWEEN 1 AND 2000`),
  check("media_size_check", sql`${t.byteSize} BETWEEN 1 AND 2097152`),
  check("media_content_check", sql`(${t.deletedAt} IS NULL AND ${t.bytes} IS NOT NULL AND octet_length(${t.bytes}) = ${t.byteSize}) OR (${t.deletedAt} IS NOT NULL AND ${t.bytes} IS NULL)`),
]);

// Derived only from links in original posts. No duplicated text or ranking data.
export const entryReferences = pgTable("entry_references", {
  sourceEntryId: bigint("source_entry_id", { mode: "number" }).notNull().references((): AnyPgColumn => entries.id, { onDelete: "cascade" }),
  targetEntryId: bigint("target_entry_id", { mode: "number" }).notNull().references((): AnyPgColumn => entries.id, { onDelete: "cascade" }),
}, t => [
  primaryKey({ columns: [t.sourceEntryId, t.targetEntryId] }),
  index("entry_references_target_idx").on(t.targetEntryId),
]);

// CHECK constraints for enumerated text columns. Build value lists from constants in languages.ts, ai-assistance.ts, or this file.
// When adding a value, update its constant and constraint together and write a migration that recreates the constraint.
const oneOf = (column: PgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", "))})`;
// One immutable reading per content hash/version. Bindings keep image ownership
// separate from content deduplication; deleting the last binding erases its text.
export const figureReadings = pgTable("figure_readings", {
  key: text("key").primaryKey(),
  version: integer("version").notNull(),
  state: text("state").notNull().default("pending"),
  reading: jsonb("reading").$type<import("../figure").FigureReading>(),
  engine: text("engine"), model: text("model"), promptVersion: text("prompt_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("figure_readings_key_check", sql`${t.key} ~ '^[a-f0-9]{64}:v[1-9][0-9]{0,5}$'`),
  check("figure_readings_version_check", sql`${t.version} between 1 and 999999 and ${t.key} like '%:v' || ${t.version}::text`),
  check("figure_readings_state_check", oneOf(t.state, ["pending", "ready", "skipped"])),
  check("figure_readings_ready_check", sql`${t.state} <> 'ready' or ${t.reading} is not null`),
]);
export const figureMedia = pgTable("figure_media", {
  mediaId: text("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
  readingKey: text("reading_key").notNull().references(() => figureReadings.key, { onDelete: "cascade" }),
}, t => [primaryKey({ columns: [t.mediaId, t.readingKey] }), index("figure_media_reading_idx").on(t.readingKey)]);
export const figureTranslations = pgTable("figure_translations", {
  mediaId: text("media_id").notNull(), readingKey: text("reading_key").notNull(),
  lang: text("lang").notNull(), state: text("state").notNull().default("ready"),
  bytes: binary("bytes"), labels: jsonb("labels").$type<string[]>(),
  labelResults: jsonb("label_results").$type<import("../figure").FigureLabelResult[]>(),
  engine: text("engine").notNull(), model: text("model").notNull(), promptVersion: text("prompt_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.mediaId, t.readingKey, t.lang] }),
  foreignKey({ name: "figure_translations_source_fk", columns: [t.mediaId, t.readingKey], foreignColumns: [figureMedia.mediaId, figureMedia.readingKey] }).onDelete("cascade"),
  check("figure_translations_lang_check", oneOf(t.lang, LANGS)),
  check("figure_translations_state_check", oneOf(t.state, ["ready", "skipped"])),
  check("figure_translations_content_check", sql`(${t.state} = 'ready' and ${t.bytes} is not null and octet_length(${t.bytes}) between 1 and 2097152 and ${t.labels} is not null) or (${t.state} = 'skipped' and ${t.bytes} is null)`),
  check("figure_translations_results_check", sql`${t.labelResults} is null or jsonb_typeof(${t.labelResults}) = 'array'`),
]);

const ENTRY_KINDS = ["topic", "reply"] as const;
const ENTRY_VIAS = ["web", "api"] as const;
export const VILLAGE_KINDS = ["open", "closed", "invite_public", "personal"] as const;
export const VILLAGE_ROLES = ["owner", "member"] as const;

export const villages = pgTable("villages", {
  id: text("id").primaryKey().default(sql`replace(gen_random_uuid()::text, '-', '')`),
  slug: text("slug").unique(),
  kind: text("kind").notNull(),
  name: text("name").notNull().default(""),
  description: text("description").notNull().default(""),
  language: text("language").unique(),
  // The language the name and description are written in; null until it is known. They are translated for readers of other languages (village_translations).
  sourceLang: text("source_lang"),
  iconMediaId: text("icon_media_id").references((): AnyPgColumn => media.id, { onDelete: "set null" }),
  iconActionId: bigint("icon_action_id", { mode: "number" }).references((): AnyPgColumn => moderationActions.id, { onDelete: "set null" }),
  system: boolean("system").notNull().default(false),
  // Retain the immutable account ID after deletion; never reassign it to the shared deleted identity.
  ownerId: text("owner_id").unique(),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, t => [
  index("villages_icon_media_idx").on(t.iconMediaId).where(sql`${t.iconMediaId} IS NOT NULL`),
  check("villages_icon_kind_check", sql`(${t.kind} <> 'personal' AND ${t.language} IS NULL) OR (${t.iconMediaId} IS NULL AND ${t.iconActionId} IS NULL)`),
  check("villages_id_check", sql`${t.id} ~ '^[a-f0-9]{32}$'`),
  check("villages_slug_check", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  check("villages_kind_check", oneOf(t.kind, VILLAGE_KINDS)),
  check("villages_personal_check", sql`(${t.kind} = 'personal' AND ${t.ownerId} IS NOT NULL AND ${t.slug} IS NULL AND ${t.language} IS NULL AND ${t.sourceLang} IS NULL AND ${t.name} = '' AND ${t.description} = '' AND NOT ${t.system}) OR (${t.kind} <> 'personal' AND ${t.ownerId} IS NULL)`),
  check("villages_language_check", oneOf(t.language, LANGS)),
  check("villages_source_lang_check", oneOf(t.sourceLang, LANGS)),
  check("villages_language_active_check", sql`${t.language} IS NULL OR (${t.system} AND ${t.kind} = 'open' AND ${t.slug} = lower(${t.language}) AND ${t.endedAt} IS NULL)`),
]);

// The name and description of a village in one reader language. One row holds both parts and is complete when ready; a row whose source_hash differs from the village's
// current texts is never shown. The name of a language village is not translated (name is null).
export const villageTranslations = pgTable("village_translations", {
  villageId: text("village_id").notNull().references(() => villages.id, { onDelete: "cascade" }),
  lang: text("lang").notNull(),
  name: text("name"),
  description: text("description"),
  state: text("state").$type<"pending" | "ready" | "failed">().notNull().default("pending"),
  sourceHash: text("source_hash").notNull(),
  model: text("model"),
  promptVersion: text("prompt_version"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.villageId, t.lang] }),
  check("village_translations_lang_check", oneOf(t.lang, LANGS)),
  check("village_translations_state_check", oneOf(t.state, ["pending", "ready", "failed"])),
  check("village_translations_hash_check", sql`${t.sourceHash} ~ '^[a-f0-9]{64}$'`),
  check("village_translations_ready_check", sql`${t.state} <> 'ready' OR ${t.name} IS NOT NULL OR ${t.description} IS NOT NULL`),
]);

export const villageMembers = pgTable("village_members", {
  villageId: text("village_id").notNull().references(() => villages.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references((): AnyPgColumn => profiles.userId, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.villageId, t.userId] }),
  index("village_members_user_idx").on(t.userId, t.joinedAt),
  check("village_members_role_check", oneOf(t.role, VILLAGE_ROLES)),
]);

// A voluntary departure prevents direct re-enrollment, even after owners change.
// Accepting a later invitation does not erase this choice.
export const villageDepartures = pgTable("village_departures", {
  villageId: text("village_id").notNull().references(() => villages.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => profiles.userId, { onDelete: "cascade" }),
  leftAt: timestamp("left_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.villageId, t.userId] })]);

// Following a village (read-only interest: it neither lets the member write nor chat there, and nobody sees how many follow). Only public villages can be followed.
export const villageFollows = pgTable("village_follows", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  villageId: text("village_id").notNull().references(() => villages.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  // The leading user_id column also serves "the villages one member follows".
  primaryKey({ columns: [t.userId, t.villageId] }),
  // Removing a village's follows (and the foreign key cascade) goes by the village.
  index("village_follows_village_idx").on(t.villageId),
]);

export const chatSequences = pgTable("chat_sequences", {
  villageId: text("village_id").primaryKey().references(() => villages.id, { onDelete: "cascade" }),
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
}, t => [check("chat_sequences_seq_check", sql`${t.seq} >= 0`)]);

export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey().default(sql`replace(gen_random_uuid()::text, '-', '')`),
  villageId: text("village_id").notNull().references(() => villages.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull().references(() => user.id, { onDelete: "no action" }),
  lang: text("lang").notNull(),
  body: text("body").notNull(),
  createdSeq: bigint("created_seq", { mode: "number" }).notNull(),
  changedSeq: bigint("changed_seq", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  hiddenAt: timestamp("hidden_at", { withTimezone: true }),
}, t => [
  check("chat_messages_id_check", sql`${t.id} ~ '^[a-f0-9]{32}$'`),
  check("chat_messages_lang_check", oneOf(t.lang, LANGS)),
  check("chat_messages_deleted_body_check", sql`${t.deletedAt} IS NULL OR ${t.body} = ''`),
  check("chat_messages_seq_check", sql`${t.createdSeq} > 0 AND ${t.changedSeq} >= ${t.createdSeq}`),
  uniqueIndex("chat_messages_created_idx").on(t.villageId, t.createdSeq),
  index("chat_messages_changed_idx").on(t.villageId, t.changedSeq),
  index("chat_messages_author_created_idx").on(t.authorId, t.createdAt, t.createdSeq),
]);

export const chatMentions = pgTable("chat_mentions", {
  messageId: text("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  publicId: text("public_id").notNull(),
  tokens: jsonb("tokens").$type<Array<{ spelling: string; prefix: string }>>().notNull().default([]),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
}, t => [primaryKey({ columns: [t.messageId, t.userId] })]);

export const chatMessageTranslations = pgTable("chat_message_translations", {
  messageId: text("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
  lang: text("lang").notNull(),
  text: text("text"),
  state: text("state").$type<"pending" | "ready" | "failed" | "paused">().notNull().default("pending"),
  sourceHash: text("source_hash").notNull(),
  model: text("model"),
  promptVersion: text("prompt_version"),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.messageId, t.lang] }),
  check("chat_message_translations_lang_check", oneOf(t.lang, LANGS)),
  check("chat_message_translations_state_check", oneOf(t.state, ["pending", "ready", "failed", "paused"])),
  check("chat_message_translations_hash_check", sql`${t.sourceHash} ~ '^[a-f0-9]{64}$'`),
  check("chat_message_translations_ready_check", sql`${t.state} <> 'ready' OR ${t.text} IS NOT NULL`),
]);

export const chatReads = pgTable("chat_reads", {
  villageId: text("village_id").notNull().references(() => villages.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
}, t => [primaryKey({ columns: [t.villageId, t.userId] }), check("chat_reads_seq_check", sql`${t.seq} >= 0`)]);

export const chatConsents = pgTable("chat_consents", {
  villageId: text("village_id").notNull().references(() => villages.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.villageId, t.userId] }), check("chat_consents_version_check", sql`${t.version} >= 1`)]);

export const villageInvites = pgTable("village_invites", {
  id: text("id").primaryKey().default(sql`replace(gen_random_uuid()::text, '-', '')`),
  villageId: text("village_id").notNull().references(() => villages.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => profiles.userId, { onDelete: "cascade" }),
  invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  state: text("state").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  responseEventId: bigint("response_event_id", { mode: "number" }).references((): AnyPgColumn => villageEvents.id, { onDelete: "set null" }),
}, t => [
  check("village_invites_kind_check", oneOf(t.kind, VILLAGE_INVITE_KINDS)),
  check("village_invites_state_check", oneOf(t.state, VILLAGE_INVITE_STATES)),
  uniqueIndex("village_invites_pending_unique").on(t.villageId, t.userId, t.kind).where(sql`${t.state} = 'pending'`),
  index("village_invites_recipient_idx").on(t.userId, t.state),
  index("village_invites_pair_idx").on(t.invitedBy, t.userId, t.responseEventId),
]);

// Management history is internal. Handles are scrubbed when the account is deleted.
export const villageEvents = pgTable("village_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  villageId: text("village_id").notNull().references(() => villages.id, { onDelete: "cascade" }),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  actorHandle: text("actor_handle").notNull(),
  action: text("action").notNull(),
  detail: jsonb("detail").$type<Record<string, string | null>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("village_events_village_idx").on(t.villageId, t.id),
  index("village_events_add_member_actor_idx").on(t.actorId, t.createdAt).where(sql`${t.action} = 'add_member'`),
  index("village_events_old_slug_idx").on(sql`(${t.detail}->>'oldSlug')`, t.createdAt)
    .where(sql`${t.action} = 'moderation_fix' AND ${t.detail}->>'oldSlug' <> ${t.detail}->>'slug'`),
]);
// Roles (app/lib/roles.server.ts). operators come from OPERATOR_EMAILS (lang is null); moderators are assigned by entry source language (lang).
export const ROLE_NAMES = ["operator", "moderator"] as const;

export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    email: text("email"),
    // Hexadecimal SHA-256 of the invitation token (plaintext in the URL). Return plaintext only once at creation; do not store it (hashInvitationToken in invitations.server.ts).
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by"),
    villageId: text("village_id").references(() => villages.id, { onDelete: "set null" }),
    note: text("note"),
    noteLang: text("note_lang"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // User created through this invitation (user.id). Set together when marking the invitation used at user creation, to trace referral responsibility.
    // No foreign key: retain the referral record even after user deletion.
    usedBy: text("used_by"),
  },
  (t) => [index("invitations_email_idx").on(t.email),
    check("invitations_note_lang_check", oneOf(t.noteLang, LANGS)),
    check("invitations_note_check", sql`(${t.note} IS NULL AND ${t.noteLang} IS NULL) OR (${t.note} IS NOT NULL AND ${t.noteLang} IS NOT NULL AND char_length(${t.note}) BETWEEN 1 AND 300)`)],
);

export const invitationNoteTranslations = pgTable("invitation_note_translations", {
  invitationId: text("invitation_id").notNull().references(() => invitations.id, { onDelete: "cascade" }),
  lang: text("lang").notNull(),
  text: text("text"),
  state: text("state").$type<"pending" | "ready" | "failed">().notNull().default("pending"),
  model: text("model"),
  promptVersion: text("prompt_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.invitationId, t.lang] }),
  check("invitation_note_translations_lang_check", oneOf(t.lang, LANGS)),
  check("invitation_note_translations_state_check", oneOf(t.state, ["pending", "ready", "failed"])),
  check("invitation_note_translations_ready_check", sql`${t.state} <> 'ready' OR (${t.text} IS NOT NULL AND char_length(${t.text}) BETWEEN 1 AND 600)`),
]);

export const profiles = pgTable(
  "profiles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    handle: text("handle").notNull().unique(),
    handleChangedAt: timestamp("handle_changed_at", { withTimezone: true }),
    displayName: text("display_name"),
    displayNameLatin: text("display_name_latin"),
    avatarMediaId: text("avatar_media_id").references((): AnyPgColumn => media.id, { onDelete: "set null" }),
    avatarActionId: bigint("avatar_action_id", { mode: "number" }).references((): AnyPgColumn => moderationActions.id, { onDelete: "set null" }),
    displayNameActionId: bigint("display_name_action_id", { mode: "number" }).references((): AnyPgColumn => moderationActions.id, { onDelete: "set null" }),
    introEntryId: bigint("intro_entry_id", { mode: "number" }).references((): AnyPgColumn => entries.id, { onDelete: "set null" }),
    // Public member links use a random identifier, never the authentication user id.
    publicId: text("public_id").notNull().default(sql`substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)`).unique(),
    // Preserve enrollment history even if an operator removes lost credentials. Only an explicit, short-lived recovery permit allows reenrollment.
    passkeyEnrolledAt: timestamp("passkey_enrolled_at", { withTimezone: true }),
    passkeyRecoveryUntil: timestamp("passkey_recovery_until", { withTimezone: true }),
    // Unique display-name key: NFKC normalization, lowercase, then NFKC again (handleKey in app/lib/handles.ts).
    // Treat names differing only in case, full-width/half-width forms, or composed characters as identical to prevent duplicates.
    handleKey: text("handle_key").notNull(),
    homeArea: text("home_area").notNull(),
    defaultVillageId: text("default_village_id").references(() => villages.id),
    defaultVillageReset: boolean("default_village_reset").notNull().default(false),
    villagePreparedAt: timestamp("village_prepared_at", { withTimezone: true }),
    readLangs: text("read_langs").array().notNull().default(sql`'{}'::text[]`),
    // The language of shown translations (content, not the interface language). null: the first enabled language the member reads.
    displayLang: text("display_lang"),
    // Time of the last home-area change. Null if unchanged since registration: the first change is allowed at any time;
    // subsequent changes require at least 90 days since this timestamp (changeHomeArea in profiles.server.ts).
    homeAreaChangedAt: timestamp("home_area_changed_at", { withTimezone: true }),
    // Generation number for signed 「AIで開く」 links (?k=). Include in the signature and increment through 「AIで開く用のリンクを無効にする」 in settings
    // to invalidate earlier generations even before expiry (app/lib/open-in-ai.server.ts).
    openInAiGeneration: integer("open_in_ai_generation").notNull().default(0),
    // Suspension: disallow writes until this time. Login, viewing, and appeals remain allowed. Expiry lifts the suspension automatically.
    // reason is the reason category; action_id identifies the action imposing this suspension. A successful appeal lifts it only if that suspension still persists.
    suspendedUntil: timestamp("suspended_until", { withTimezone: true }),
    suspendedReason: text("suspended_reason"),
    suspendedActionId: bigint("suspended_action_id", { mode: "number" }).references((): AnyPgColumn => moderationActions.id, { onDelete: "set null" }),
    // Time stances and 「なるほど」 were excluded from counts (operator action exclude_reactions). Null means no exclusion. Covers all this member's stances and 「なるほど」, including reactions before the action
    // (check this column on every read). include_reactions restores them all. action_id identifies the exclusion action; a successful appeal restores counts only if that exclusion still persists.
    reactionsExcludedAt: timestamp("reactions_excluded_at", { withTimezone: true }),
    reactionsExcludedActionId: bigint("reactions_excluded_action_id", { mode: "number" }).references((): AnyPgColumn => moderationActions.id, { onDelete: "set null" }),
    // Notification email preference (immediate | daily | none; default daily; app/lib/notifications.ts).
    emailPref: text("email_pref").notNull().default(DEFAULT_EMAIL_PREF),
    // Last interface locale, saved at login and on language changes so email uses the recipient's interface language. Null means the default language.
    uiLocale: text("ui_locale"),
    // Null follows the device; explicit choices apply across the member's devices.
    colorScheme: text("color_scheme"),
    // Optional passkey confirmation for named writes; preference changes always require a signature.
    signPosts: boolean("sign_posts").notNull().default(false),
    residenceCountry: text("residence_country"),
    adultConfirmedAt: timestamp("adult_confirmed_at", { withTimezone: true }),
    trialConsentVersion: integer("trial_consent_version"),
    trialConsentAt: timestamp("trial_consent_at", { withTimezone: true }),
    stanceConsentVersion: integer("stance_consent_version"),
    stanceConsentAt: timestamp("stance_consent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("profiles_handle_check", sql`${t.handle} ~ '^[a-z0-9][a-z0-9_-]{1,29}$'`),
    check("profiles_home_area_check", oneOf(t.homeArea, AREAS)),
    uniqueIndex("profiles_handle_key_unique").on(t.handleKey),
    index("profiles_avatar_media_idx").on(t.avatarMediaId).where(sql`${t.avatarMediaId} IS NOT NULL`),
    // Null passes CHECK, representing a member who is not suspended.
    check("profiles_suspended_reason_check", oneOf(t.suspendedReason, REPORT_REASONS)),
    check("profiles_email_pref_check", oneOf(t.emailPref, EMAIL_PREFS)),
    check("profiles_color_scheme_check", oneOf(t.colorScheme, ["light", "dark"])),
  ],
);

// Reserve previous usernames through the same namespace lock used by registration and renames.
export const handleHolds = pgTable("handle_holds", {
  handleKey: text("handle_key").primaryKey(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  heldUntil: timestamp("held_until", { withTimezone: true }).notNull(),
});

export const entries = pgTable(
  "entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(), // "topic" | "reply"
    threadId: bigint("thread_id", { mode: "number" }).references((): AnyPgColumn => entries.id),
    parentId: bigint("parent_id", { mode: "number" }).references((): AnyPgColumn => entries.id),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    lang: text("lang").notNull(),
    langCode: text("lang_code"),
    langSource: text("lang_source").$type<"explicit" | "detected" | "default" | "checked">(),
    title: text("title"),
    body: text("body").notNull(),
    // Rendered HTML cache. Re-render when displayed if htmlVersion differs from RENDER_VERSION in markdown.server.ts.
    html: text("html"),
    htmlVersion: integer("html_version").notNull().default(0),
    // The card version of `html` (the beginning of a long body, cut on the server; app/lib/markdown.server.ts renderEntry). Made in the same render as `html` and stored with the same
    // html_version. null: the body was not cut (a card uses `html`), or the row is a reply (replies have no card).
    cardHtml: text("card_html"),
    // SHA-256 of source title and body (app/lib/source-hash.server.ts), used to determine whether a translation comes from the current source.
    // Backfill pre-0005 rows in migration 0006.
    sourceHash: text("source_hash"),
    // Content hashes may repeat after edits; mention destinations belong to a distinct source revision.
    mentionRevision: integer("mention_revision").notNull().default(0),
    // null = not stated: a post written on screen carries no value. Only frontmatter or the API set one (none | polish | draft | coauthor).
    aiAssistance: text("ai_assistance"),
    via: text("via").notNull().default("web"),
    // Author's home area at posting time: a snapshot that does not change with later profile changes. Null without a profile.
    // Use this to count cross-area participation and observation metrics. Migration 0020 backfills pre-0019 rows from their current home area.
    authorArea: text("author_area"),
    villageId: text("village_id").references(() => villages.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Time of the last versioned body or title edit. Initial grace-window corrections leave this null.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // First reply or Insightful mark. Never cleared when the reaction is removed.
    historyStartedAt: timestamp("history_started_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Time moderation hid the entry (reset to null when unhidden). Show hidden content only to its author, assigned moderators, and operators
    // (canSeeHidden in app/lib/roles.server.ts). Do not use it as translation context either.
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    // Time and action of the last moderation status change (hide, unhide, operator deletion, restoration). Used for the changes-feed timestamp and reversal after a successful appeal
    // only if the action's effect still persists. Not populated by author deletion.
    moderatedAt: timestamp("moderated_at", { withTimezone: true }),
    moderationActionId: bigint("moderation_action_id", { mode: "number" }).references((): AnyPgColumn => moderationActions.id, { onDelete: "set null" }),
    // Whether the entry asks for a stance (a question). Set only when creating a topic and never change later (checkStanceAttributes in app/lib/stances.ts checks combinations).
    asksStance: boolean("asks_stance").notNull().default(false),
    // Original question referenced by an alternative framing. Set only at question creation and never change later. Entries are soft-deleted, but SET NULL prevents dangling references after physical deletion in tests or manual operations.
    altOf: bigint("alt_of", { mode: "number" }).references((): AnyPgColumn => entries.id, { onDelete: "set null" }),
    // Reply label (agree | disagree | neither | objection). Only for replies to questions, enforced by the app because it examines another row. Authors may change it on edit.
    stanceTag: text("stance_tag"),
    // Time of the first stance, pinning the question so its author can no longer edit its title or body. Never clear it once set. Do not expose it in the UI or Markdown or include it in changed_at
    // to prevent inferring stances from this timestamp. Set on the first stance from a member other than the question author; the author's own stance does not set it.
    // setStance writes it; getEditableEntry in app/lib/entries.server.ts checks it before author edits.
    stanceLockedAt: timestamp("stance_locked_at", { withTimezone: true }),
    // Last change to Markdown-visible information outside title/body (reply label or alternative-framing list on the original question). Included in changed_at for the changes feed and manifest.
    // Never move the value backward (touchQuestion in app/lib/questions.server.ts).
    metaChangedAt: timestamp("meta_changed_at", { withTimezone: true }),
    // Change timestamp: latest of creation, last edit, deletion, moderation status change (hide, unhide, operator deletion, restoration), and changes outside title/body (meta_changed_at).
    // Used by /changes.md and the manifest's update timestamp. A STORED generated column keeps all update paths and existing rows consistent (0039; 0041 added meta_changed_at to the expression).
    // The (changed_at, id) index supports changes-feed ordering and cursors.
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .generatedAlwaysAs(
        sql.raw("greatest(created_at, coalesce(edited_at, created_at), coalesce(deleted_at, created_at), coalesce(moderated_at, created_at), coalesce(meta_changed_at, created_at))"),
      ),
    // Listing aggregates used only by topic rows. Update on each reply creation/deletion (createReply and recomputeThreadActivity in entries.server.ts),
    // so listings do not aggregate replies on every call. reply_count counts undeleted replies; last_activity_at is the maximum created_at
    // across the topic and undeleted replies. Migration 0014 backfills existing rows.
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    replyCount: integer("reply_count").notNull().default(0),
  },
  (t) => [
    index("entries_thread_idx").on(t.threadId, t.createdAt, t.id),
    index("entries_topic_village_created_idx").on(t.villageId, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.kind} = 'topic' and ${t.deletedAt} is null`),
    check("entries_village_topic_check", sql`${t.kind} = 'topic' OR ${t.villageId} IS NULL`),
    // Replies to replies, for calculating cross-area participation.
    index("entries_parent_idx").on(t.parentId),
    // Entries by author. Queries: member data export (/settings/export, reading their entries in creation order) and entries.author_id foreign-key checks when deleting a user
    // (without an index, these scan all entries). Observation metrics for author counts filter by period and use entries_created_idx.
    index("entries_author_idx").on(t.authorId, t.createdAt),
    index("entries_created_idx").on(t.createdAt),
    // Changes-feed ordering and cursor (changed_at, id).
    index("entries_changed_idx").on(t.changedAt, t.id),
    // Join/filter by thread root (topic id for topics; thread_id for replies), avoiding full scans in the changes feed and manifest.
    index("entries_thread_root_idx").on(sql`coalesce(${t.threadId}, ${t.id})`),
    // Static listing keys stay on entries. Frequently changing activity/ranking
    // keys live on topic_listing_stats so reply updates may use HOT here.
    index("entries_topic_created_idx")
      .on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.kind} = 'topic' and ${t.deletedAt} is null`),
    index("entries_question_created_idx")
      .on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.kind} = 'topic' and ${t.deletedAt} is null and ${t.asksStance}`),
    index("entries_titled_created_idx")
      .on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.kind} = 'topic' and ${t.deletedAt} is null and ${t.title} is not null`),
    // The original question's 「異議」 section, listing alternative framings.
    index("entries_alt_of_idx")
      .on(t.altOf, t.createdAt.desc().nullsFirst())
      .where(sql`${t.altOf} is not null`),
    // Filter by the reasons section and reply label.
    index("entries_thread_stance_tag_idx")
      .on(t.threadId, t.stanceTag, t.createdAt, t.id)
      .where(sql`${t.stanceTag} is not null`),
    check("entries_kind_check", oneOf(t.kind, ENTRY_KINDS)),
    check("entries_lang_code_check", sql`${t.langCode} is null or (${t.lang} = 'other' and ${t.langCode} ~ '^[a-z]{2,3}$')`),
    check("entries_lang_source_check", sql`${t.langSource} is null or ${oneOf(t.langSource, ["explicit", "detected", "default", "checked"])}`),
    check("entries_lang_check", oneOf(t.lang, SOURCE_LANGS)),
    check("entries_ai_assistance_check", oneOf(t.aiAssistance, AI_ASSISTANCE)),
    check("entries_via_check", oneOf(t.via, ENTRY_VIAS)),
    // Null passes CHECK, representing an author without a profile.
    check("entries_author_area_check", oneOf(t.authorArea, AREAS)),
    // Only topics can be questions. Only questions can be alternative framings, without self-reference. Reply labels require replies (the app checks that they reply to questions). Only questions can be pinned.
    check("entries_asks_stance_kind_check", sql`not ${t.asksStance} or ${t.kind} = 'topic'`),
    check("entries_alt_of_check", sql`${t.altOf} is null or (${t.asksStance} and ${t.altOf} <> ${t.id})`),
    check("entries_stance_tag_check", sql`${t.stanceTag} is null or (${t.kind} = 'reply' and ${oneOf(t.stanceTag, STANCE_TAGS)})`),
    check("entries_stance_locked_check", sql`${t.stanceLockedAt} is null or ${t.asksStance}`),
    // A title is never an empty string (a missing title is always NULL), a question (asks_stance) always has its title (the proposition),
    // and only topics carry a title (so that the "long posts" notion depends on the presence of a title alone).
    check("entries_title_not_blank_check", sql`${t.title} is null or btrim(${t.title}) <> ''`),
    check("entries_question_title_check", sql`not ${t.asksStance} or ${t.title} is not null`),
    check("entries_reply_title_check", sql`${t.kind} = 'topic' or ${t.title} is null`),
  ],
);

// Narrow derived rows keep mutable listing keys away from post text and caches.
// Database triggers maintain these in the same transaction as entries, votes
// and reaction-exclusion changes, including direct SQL writes and deletions.
export const topicListingStats = pgTable("topic_listing_stats", {
  topicId: bigint("topic_id", { mode: "number" }).primaryKey().references(() => entries.id, { onDelete: "cascade" }),
  lang: text("lang").notNull(),
  villageId: text("village_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
  asksStance: boolean("asks_stance").notNull().default(false),
  insightfulCount: integer("insightful_count").notNull().default(0),
}, t => [
  index("topic_listing_activity_idx").on(t.lastActivityAt.desc(), t.topicId.desc()),
  index("topic_listing_question_activity_idx").on(t.lastActivityAt.desc(), t.topicId.desc()).where(sql`${t.asksStance} = true`),
  index("topic_listing_lang_activity_idx").on(t.lang, t.lastActivityAt.desc(), t.topicId.desc()),
  index("topic_listing_village_activity_idx").on(t.villageId, t.lastActivityAt.desc(), t.topicId.desc()),
  index("topic_listing_insightful_idx").on(t.insightfulCount.desc(), t.createdAt.desc(), t.topicId.desc()),
  check("topic_listing_count_check", sql`${t.insightfulCount} >= 0`),
]);

export const entryMedia = pgTable("entry_media", {
  entryId: bigint("entry_id", { mode: "number" }).notNull().references(() => entries.id, { onDelete: "cascade" }),
  mediaId: text("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
}, t => [primaryKey({ columns: [t.entryId, t.mediaId] }), index("entry_media_media_idx").on(t.mediaId, t.entryId)]);

// Embedding dimensions (gemini-embedding-001 outputDimensionality; use the same dimensions even if EMBEDDING_MODEL changes).
export const EMBEDDING_DIM = 768;

// Entry embeddings (semantic search; app/lib/embeddings.server.ts). One row per entry × model, generated from source title/body.
// source_hash identifies that source version (entries.source_hash). Exclude stale rows from search and observations; embed_entry rebuilds them.
// dim is the model's output dimension (matching EMBEDDING_DIM), checked to avoid mixing models with other dimensions.
// Keep no rows for deleted or hidden entries. Remove on deletion/hiding; embed_entry rebuilds on unhide/restoration.
// Index: HNSW cosine distance (pgvector; search takes the top N ordered by embedding <=> query). The index scan picks the candidates first and the
// query then drops other models and deleted entries, so a search can return fewer than N rows.
export const entryEmbeddings = pgTable(
  "entry_embeddings",
  {
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    dim: integer("dim").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }).notNull(),
    sourceHash: text("source_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.model] }),
    index("entry_embeddings_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    check("entry_embeddings_dim_check", sql`${t.dim} = ${sql.raw(String(EMBEDDING_DIM))}`),
  ],
);

// Pre-edit revisions. Outside the initial grace window, preserve the previous title and body before replacing them.
// editedAt and editorId identify the time and actor of the edit that replaced this revision.
export const entryRevisions = pgTable(
  "entry_revisions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => entries.id),
    title: text("title"),
    body: text("body").notNull(),
    mentionRevision: integer("mention_revision").notNull().default(0),
    editedAt: timestamp("edited_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    editorId: text("editor_id")
      .notNull()
      .references(() => user.id),
  },
  (t) => [index("entry_revisions_entry_idx").on(t.entryId)],
);

export type SavedMentionBinding = { spelling: string; prefix: string | null; userId: string | null };
// Immutable per-source-revision bindings, including spellings that resolved to nobody.
// Soft deletion removes render caches but leaves these records available for restoration.
export const entryMentionSnapshots = pgTable("entry_mention_snapshots", {
  entryId: bigint("entry_id", { mode: "number" }).notNull().references(() => entries.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  sourceHash: text("source_hash"),
  body: text("body").notNull(),
  bindings: jsonb("bindings").$type<SavedMentionBinding[]>().notNull(),
}, t => [primaryKey({ columns: [t.entryId, t.revision] })]);

// API tokens (app/lib/tokens.server.ts). kind: read (Markdown/read APIs) | draft (POST /api/drafts).
// Show plaintext (tml_<kind>_<43 base64url characters>) only once at creation; store only hexadecimal SHA-256. Revoke by setting revoked_at
// without deleting the row, since draft token_id identifies its originating token. Update last_used_at at most once per minute.
export const API_TOKEN_KINDS = ["read", "draft"] as const;
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // "read" | "draft"
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_tokens_user_idx").on(t.userId), check("api_tokens_kind_check", oneOf(t.kind, API_TOKEN_KINDS))],
);

// Fixed rate-limit windows (app/lib/rate-limit.server.ts). Count per (key, window_start). Remove expired rows (past expires_at)
// during the first counter update in a new window.
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("rate_limits_expires_idx").on(t.expiresAt)],
);

// Drafts. Web-form drafts and API drafts (via = "api") share this table.
// Publishing creates an entry and deletes the draft (publishDraft in app/lib/drafts.server.ts).
// Saving permits incomplete content; publishing applies the same validation as entry creation.
export const drafts = pgTable(
  "drafts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "topic" | "reply"
    threadId: bigint("thread_id", { mode: "number" }).references(() => entries.id),
    parentId: bigint("parent_id", { mode: "number" }).references(() => entries.id),
    lang: text("lang").notNull(),
    title: text("title"),
    body: text("body").notNull().default(""),
    // Every mutation advances this version, including AI edits, so approval cannot silently publish a later draft.
    version: integer("version").notNull().default(1),
    villageId: text("village_id").references(() => villages.id),
    // Browser response context lives only until publication, never on entries.
    responseTo: bigint("response_to", { mode: "number" }).references(() => entries.id, { onDelete: "set null" }),
    // null = not stated (see entries.aiAssistance). Handed on to the post when the draft is published.
    aiAssistance: text("ai_assistance"),
    via: text("via").notNull().default("web"), // "web" | "api"
    // For via = "api", the token that created the draft (its row survives revocation) and frontmatter exactly as received (null if absent).
    tokenId: bigint("token_id", { mode: "number" }).references(() => apiTokens.id, { onDelete: "set null" }),
    rawFrontmatter: text("raw_frontmatter"),
    // Stable authenticated creator identity, never supplied by tool arguments or MCP clientInfo.
    // OAuth uses oauth:<client_id>; personal tokens use token:<database id>. Null legacy API rows remain bound to tokenId.
    clientKey: text("client_key"),
    clientId: text("client_id"),
    clientName: text("client_name"),
    clientUri: text("client_uri"),
    clientUpdatedAt: timestamp("client_updated_at", { withTimezone: true }),
    // Latest API/MCP-supplied text, used only until publication. Browser edits do not replace it.
    aiBaseline: jsonb("ai_baseline").$type<{ title: string | null; body: string }>(),
    aiSource: text("ai_source").$type<"api" | "mcp">(),
    // Question and reply labels have the same meanings as the corresponding entries columns and transfer on publication. alt_of is set only at draft creation.
    asksStance: boolean("asks_stance").notNull().default(false),
    altOf: bigint("alt_of", { mode: "number" }).references(() => entries.id, { onDelete: "set null" }),
    stanceTag: text("stance_tag"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("drafts_author_idx").on(t.authorId, t.updatedAt),
    check("drafts_version_check", sql`${t.version} >= 1`),
    check("drafts_village_topic_check", sql`${t.kind} = 'topic' OR ${t.villageId} IS NULL`),
    check("drafts_response_to_check", sql`${t.responseTo} IS NULL OR (${t.kind} = 'topic' AND ${t.via} = 'web')`),
    check("drafts_kind_check", oneOf(t.kind, ENTRY_KINDS)),
    check("drafts_via_check", oneOf(t.via, ENTRY_VIAS)),
    check("drafts_asks_stance_kind_check", sql`not ${t.asksStance} or ${t.kind} = 'topic'`),
    check("drafts_alt_of_check", sql`${t.altOf} is null or (${t.asksStance} and ${t.kind} = 'topic')`),
    check("drafts_stance_tag_check", sql`${t.stanceTag} is null or (${t.kind} = 'reply' and ${oneOf(t.stanceTag, STANCE_TAGS)})`),
    // Only API drafts have tokens; web-form drafts have no token id. API drafts survive token deletion (set null).
    check("drafts_token_via_check", sql`${t.via} = 'api' or ${t.tokenId} is null`),
  ],
);

// Two-minute, single-use WebAuthn challenges. The challenge bytes contain the SHA-256 of the canonical payload as well as a random nonce.
// All consumers lock the member first and consume the challenge together with the credential counter and the authorized mutation.
export const signingChallenges = pgTable(
  "signing_challenges",
  {
    challenge: text("challenge").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    payload: text("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    formHash: text("form_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("signing_challenges_user_idx").on(t.userId, t.expiresAt), check("signing_challenges_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`)],
);

// Append-only acceptance evidence for each signed version, including handle changes. Keep the public-key snapshot after a credential is removed.
// The exact canonical JSON and its challenge binding permit verification without relying on a live challenge or credential table.
export const memberSignatures = pgTable(
  "member_signatures",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id").notNull().references(() => user.id),
    entryId: bigint("entry_id", { mode: "number" }).references(() => entries.id),
    sourceHash: text("source_hash"),
    operation: text("operation").notNull(),
    payload: text("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    challenge: text("challenge").notNull().unique(),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    rpId: text("rp_id").notNull(),
    origin: text("origin").notNull(),
    assertion: jsonb("assertion").$type<Record<string, unknown>>().notNull(),
    authenticatorData: text("authenticator_data").notNull(),
    clientDataJson: text("client_data_json").notNull(),
    signature: text("signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("member_signatures_user_idx").on(t.userId, t.createdAt), index("member_signatures_entry_idx").on(t.entryId, t.sourceHash)],
);

// Operator recovery evidence stays private. A recovery permit does not erase enrollment history and expires after thirty minutes.
export const passkeyRecoveries = pgTable("passkey_recoveries", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: text("user_id").notNull().references(() => user.id),
  operatorId: text("operator_id").notNull().references(() => user.id),
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// DB job queue (app/lib/jobs). Implemented locally because pg-boss is incompatible with PGlite.
// status: queued | running | done | failed. Increment attempts on every claim, including jobs whose process crashed while running.
// Apply dedupe_key uniqueness only to unfinished jobs (queued/running), using a partial unique index.
// This allows requeuing the same key after completion/failure, such as an edit restoring a previous source version.
export const jobs = pgTable(
  "jobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("queued"),
    priority: smallint("priority").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_due_idx").on(t.status, t.priority, t.runAt, t.id),
    index("jobs_entry_idx").on(sql`(${t.payload}->>'entryId')`, t.kind)
      .where(sql`${t.status} in ('queued', 'running', 'failed')`),
    index("jobs_message_idx").on(sql`(${t.payload}->>'messageId')`, t.kind)
      .where(sql`${t.status} in ('queued', 'running', 'failed')`),
    index("jobs_kind_dedupe_idx").on(t.kind, t.dedupeKey),
    check("jobs_status_check", oneOf(t.status, ["queued", "running", "done", "failed"])),
    check("jobs_done_checkpoint_check", sql`${t.status} <> 'done' or not (${t.payload} ? 'paidTranslationCalls')`),
    uniqueIndex("jobs_dedupe_active_idx")
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

// LLM-call cost ledger (app/lib/llm/usage.server.ts). One row per call.
// cost_usd_micro is an integer in millionths of a dollar. The current UTC month's total determines the budget state: normal, degraded, or stopped.
// purpose: translate | retry (one retranslation after a mistranslation report) | judge | embed | chat.
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    engine: text("engine").notNull(),
    model: text("model").notNull(),
    purpose: text("purpose").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsdMicro: bigint("cost_usd_micro", { mode: "number" }).notNull().default(0),
    reserved: boolean("reserved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("llm_usage_created_idx").on(t.createdAt),
    index("llm_usage_reserved_idx").on(t.createdAt).where(sql`${t.reserved} = true`),
    check("llm_usage_purpose_check", oneOf(t.purpose, ["translate", "retry", "judge", "embed", "chat", "moderation"])),
  ],
);

// Translations: derivatives of source entries, one row per entry × field × language × kind.
// field: title | body. kind: primary (main machine translation, including the single retry after a mistranslation report) | secondary (independent system for disagreement measurement, not displayed) | human (manual correction).
// Author translations (kind = author) are no longer supported; migration 0042 deleted the rows.
// Populate engine/model for machine translations (primary/secondary), allowing observation exports to identify whether the secondary used the same provider as the primary. Null for human.
// source_hash is the source version when this translation was created or verified (entries.source_hash). Do not display stale primary translations; retranslate them.
// Keep human translations when the source changes, adding "stale" to flags. Other flags include structure_mismatch and retried_after_report (retranslated after a mistranslation report; app/lib/llm/flags.ts).
// html/html_version cache rendered body translations using the same rules as entries.html. Title translations are plaintext and do not use them.
export const translations = pgTable(
  "translations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => entries.id),
    field: text("field").notNull(), // "title" | "body"
    lang: text("lang").notNull(),
    kind: text("kind").notNull(), // "primary" | "secondary" | "human"
    text: text("text").notNull(),
    engine: text("engine"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    glossaryVersion: text("glossary_version"),
    sourceHash: text("source_hash"),
    // Rendering uses the source's saved mention bindings, including for an older human translation.
    mentionRevision: integer("mention_revision"),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    // Translated with the secondary engine because the primary refused or failed. True only for kind = primary rows; engine/model identify the secondary engine.
    // Expose in the UI with the 「代替」 label and in Markdown as fallback: true.
    fallback: boolean("fallback").notNull().default(false),
    createdBy: text("created_by").references(() => user.id),
    html: text("html"),
    htmlVersion: integer("html_version").notNull().default(0),
    // The card version of `html`, for the translation of the body of a topic (see entries.card_html). null: not cut, or not a topic body.
    cardHtml: text("card_html"),
    // First browser display only; no reader identity or view count.
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    // Lifetime display marker: source revisions reset firstSeenAt, but retain this flag.
    everSeen: boolean("ever_seen").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("translations_entry_field_lang_kind_idx").on(t.entryId, t.field, t.lang, t.kind),
    check("translations_field_check", oneOf(t.field, ["title", "body"])),
    check("translations_lang_check", oneOf(t.lang, LANGS)),
    check("translations_kind_check", oneOf(t.kind, ["primary", "secondary", "human"])),
  ],
);

// Translation history. Preserve the old row before overwriting a translation (retranslation or saving a manual correction)
// via recordRevision in app/lib/translation-revisions.server.ts. created_at is the old row's creation time; replaced_at is the replacement time.
// reason: retranslate (machine retranslation after a source edit or requeue), human_edit (manual correction after a mistranslation report),
// report_retry (automatic retranslation using a higher model after a report). Deleting an entry also deletes its history (purgeEntryDerivatives).
// created_by holds a user id without a foreign key, so history does not block member deletion. Exclude it from observation exports.
export const TRANSLATION_REVISION_REASONS = ["retranslate", "human_edit", "report_retry"] as const;
export const translationRevisions = pgTable(
  "translation_revisions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => entries.id),
    field: text("field").notNull(),
    lang: text("lang").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    engine: text("engine"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    glossaryVersion: text("glossary_version"),
    sourceHash: text("source_hash"),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    fallback: boolean("fallback").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    replacedAt: timestamp("replaced_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason").notNull(),
  },
  (t) => [
    index("translation_revisions_entry_idx").on(t.entryId, t.lang, t.field, t.kind),
    check("translation_revisions_reason_check", oneOf(t.reason, TRANSLATION_REVISION_REASONS)),
  ],
);

// Sentence boundaries (segmentSentences in app/lib/segment.ts), rebuilt on every post and edit.
// start/end are positions in the source body (entries.body), measured in JavaScript string indices (UTF-16 code units); end is exclusive. Sentence ids are s-<idx>.
export const segments = pgTable(
  "segments",
  {
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => entries.id),
    idx: integer("idx").notNull(),
    start: integer("start").notNull(),
    end: integer("end").notNull(),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.idx] })],
);

// Disagreements: semantic differences between primary and secondary translations of one source sentence. Hidden in the UI pending a decision after native-speaker spot checks.
// judge_engine/judge_model identify the judge. The secondary engine/model come from translations rows with kind = secondary.
// source_hash is the measured source version (entries.source_hash). A title-only edit carries this into the new version because the body is unchanged.
// judge_prompt_version identifies the judge prompt revision (JUDGE_PROMPT_VERSION). Body-changing edits delete the entry's disagreements.
export const divergences = pgTable(
  "divergences",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => entries.id),
    lang: text("lang").notNull(),
    segmentIdx: integer("segment_idx").notNull(),
    severity: text("severity").notNull(), // "low" | "medium" | "high"
    // Kind: meaning (semantic difference) | tone (a hedged statement became categorical or vice versa).
    category: text("category").notNull().default("meaning"),
    note: text("note").notNull(),
    judgeEngine: text("judge_engine"),
    judgeModel: text("judge_model"),
    sourceHash: text("source_hash"),
    judgePromptVersion: text("judge_prompt_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("divergences_entry_idx").on(t.entryId, t.lang),
    check("divergences_severity_check", oneOf(t.severity, ["low", "medium", "high"])),
    check("divergences_category_check", oneOf(t.category, ["meaning", "tone"])),
  ],
);

// Mistranslation reports. status: open | resolved. Saving an operator's manual correction (kind = human) resolves open reports for the same entry/language/field.
// route: retry (awaiting automatic retranslation; omit from the moderator list until 30 minutes pass) | moderator (default: reports after retranslation, without a retranslation target, after a failed retranslation,
// or beyond the daily limit; shown in /admin/translations). If retranslation stalls, change retry to moderator.
// source_hash identifies the source version at reporting time (entries.source_hash). Edits carry reports for unchanged fields to the new version.
// retry_slot permits one automatic retry per entry/language/field/source version. Concurrent first reports atomically claim one slot;
// rerouting keeps it consumed. Titles and bodies have independent slots, and only the reported field is retranslated.
export const TRANSLATION_REPORT_ROUTES = ["retry", "moderator"] as const;
export const translationReports = pgTable(
  "translation_reports",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => entries.id),
    lang: text("lang").notNull(),
    field: text("field").notNull(), // "title" | "body"
    reporterId: text("reporter_id")
      .references(() => user.id, { onDelete: "set null" }),
    excerpt: text("excerpt").notNull().default(""),
    note: text("note").notNull().default(""),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedBy: text("resolved_by").references(() => user.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    outcome: text("outcome"),
    sourceLang: text("source_lang"),
    // Routes: retry awaits automatic retranslation, briefly hidden from the moderator list; moderator appears in that list. If retranslation stalls, move retry to moderator.
    route: text("route").notNull().default("moderator"),
    sourceHash: text("source_hash"),
    // Automatic retry quota: one automatic retry per translation. The first report claims true; never reset it to false even after rerouting to moderator
    // so failure or skipping still consumes the slot and a later report cannot call the expensive model again. Only one true row per entry/language/field/source version.
    retrySlot: boolean("retry_slot").notNull().default(false),
  },
  (t) => [
    index("translation_reports_status_idx").on(t.status, t.createdAt),
    check("translation_reports_outcome_check", oneOf(t.outcome, TRANSLATION_REPORT_OUTCOMES)),
    check("translation_reports_result_status_check", sql`${t.outcome} IS NULL OR (${t.status} = 'resolved' AND ${t.resolvedAt} IS NOT NULL)`),
    check("translation_reports_status_check", oneOf(t.status, ["open", "resolved"])),
    check("translation_reports_route_check", oneOf(t.route, TRANSLATION_REPORT_ROUTES)),
    check("translation_reports_retry_hash_check", sql`${t.route} <> 'retry' OR ${t.sourceHash} IS NOT NULL`),
    check("translation_reports_retry_slot_check", sql`NOT ${t.retrySlot} OR ${t.sourceHash} IS NOT NULL`),
    uniqueIndex("translation_reports_retry_once_idx").on(t.entryId, t.lang, t.field, t.sourceHash).where(sql`${t.retrySlot}`),
  ],
);

// Operator-managed glossary. Import initial entries from docs/drafts/glossary-initial.yaml with pnpm glossary:import. Entries provide translation candidates and notes, not a single correct answer; keep_original preserves the source wording.
// Glossary version: first 12 characters of SHA-256 across all row contents (translations.glossary_version; glossaryVersionOf in translations.server.ts).
export const glossaryEntries = pgTable(
  "glossary_entries",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    term: text("term").notNull(),
    lang: text("lang").notNull(), // Term language.
    targetLang: text("target_lang").notNull(),
    candidates: text("candidates").array().notNull().default(sql`'{}'::text[]`),
    note: text("note").notNull().default(""),
    keepOriginal: boolean("keep_original").notNull().default(false),
    // Needs review: entries not yet verified by speakers of that language. Does not affect translation prompts or the glossary version.
    needsReview: boolean("needs_review").notNull().default(false),
    // Last editor and edit time, matching the last glossary_revisions row. Write in the same transaction so listings can show them without querying history.
    updatedBy: text("updated_by").references(() => user.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Deletion time (null means active). Set this instead of removing the row, keeping history linked to its entry. Exclude deleted entries from translation and glossary versions.
    // Readding the same term/source-language/target-language restores this row rather than creating a new one; the unique index below includes deleted rows.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("glossary_entries_term_idx").on(t.term, t.lang, t.targetLang)],
);

// Append-only glossary change history. Only the three writes in app/lib/glossary.server.ts add rows, in the same transaction as the entry update.
// Null before means creation; null after means deletion; both present mean modification (glossaryChangeKind in app/lib/glossary.ts). Store absence as SQL NULL, not JSON null.
export const glossaryRevisions = pgTable(
  "glossary_revisions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    // Entries use deleted_at instead of physical deletion, so history always remains linked to its entry.
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => glossaryEntries.id),
    before: jsonb("before").$type<GlossaryContent>(),
    after: jsonb("after").$type<GlossaryContent>(),
    // Editor. Retain history after the member row is deleted. Null means no recorded editor (backfilled entries with null updated_by) or a deleted member.
    editorId: text("editor_id").references(() => user.id, { onDelete: "set null" }),
    // Change source (admin: UI; import: pnpm glossary:import). Check this so imports do not overwrite rows manually edited through the UI.
    via: text("via").notNull().default("admin"),
    // Optional proposal entry: a topic id checked by the app (resolveProposal in glossary.server.ts). Do not copy its title or body.
    proposalEntryId: bigint("proposal_entry_id", { mode: "number" }).references(() => entries.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // History per entry, read newest first.
    index("glossary_revisions_entry_idx").on(t.entryId, t.id),
    // Index for foreign keys on member deletion or physical entry deletion. Also supports finding changes from a proposal entry.
    index("glossary_revisions_editor_idx").on(t.editorId),
    index("glossary_revisions_proposal_idx")
      .on(t.proposalEntryId)
      .where(sql`${t.proposalEntryId} is not null`),
    check("glossary_revisions_change_check", sql`${t.before} is not null or ${t.after} is not null`),
    check("glossary_revisions_via_check", oneOf(t.via, GLOSSARY_VIAS)),
  ],
);

// "Insightful" means the reader gained a new perspective. Migration 0047 removes the earlier agreement votes because their meaning differs (it refuses to run on a database with vote rows unless tomola.allow_vote_delete = on is set).
// One row per (post, member); adding or removing the reaction adds or deletes the row. The names (votes, setVote, /vote) are kept.
// voter_area is the voter's home area when the reaction was given and is never rewritten afterwards. Counting is per area internally (for operator observation and future
// ordering), but members only ever see the total and the number of languages (app/lib/votes.server.ts).
export const votes = pgTable(
  "votes",
  {
    // Physical entry deletion cascades to votes. Soft deletion only sets deleted_at and keeps votes; they appear nowhere if the entry cannot be read.
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    voterId: text("voter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    voterArea: text("voter_area").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.voterId] }),
    // Votes by voter, for viewer vote state and member-deletion cascade. The primary key (entry_id, voter_id) cannot serve searches by voter_id alone.
    index("votes_voter_idx").on(t.voterId),
    check("votes_voter_area_check", oneOf(t.voterArea, AREAS)),
  ],
);

// Stances: one-click choice among three options on a question (asks_stance topic), counted without names. One current row per question/member; withdrawal deletes it and is recorded in stance_changes.
// Never expose another member's stance in any screen, Markdown, API, or export (app/lib/stances.server.ts, app/lib/distribution.server.ts). Only the member may see their own.
// area snapshots the current language area (profiles.home_area); changing areas updates all this member's rows in the same transaction. Only distribution.server.ts counts stances,
// exposing only stance totals and the number of language areas. version counts stance_changes rows per question/member to detect stale screens; withdrawal never resets it.
export const stances = pgTable(
  "stances",
  {
    questionId: bigint("question_id", { mode: "number" })
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    position: text("position").notNull(), // agree | disagree | neither
    area: text("area").notNull(),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.questionId, t.userId] }),
    // Member's own listing, language-area updates, and the member-deletion foreign key.
    index("stances_user_idx").on(t.userId),
    check("stances_position_check", oneOf(t.position, POSITIONS)),
    check("stances_area_check", oneOf(t.area, AREAS)),
    check("stances_version_check", sql`${t.version} >= 1`),
  ],
);

// Append-only stance-change history. Add a row only on change (null from for initial selection, null to for withdrawal). A member's deletion request removes all rows per question (right to deletion).
// trigger_area snapshots the posting-time author area of the trigger entry (an entry in the question's thread marked 「なるほど」 by this member). area snapshots the member's area at change time; never update later.
export const stanceChanges = pgTable(
  "stance_changes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    questionId: bigint("question_id", { mode: "number" })
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fromPosition: text("from_position"),
    toPosition: text("to_position"),
    triggerEntryId: bigint("trigger_entry_id", { mode: "number" }).references(() => entries.id, { onDelete: "set null" }),
    triggerArea: text("trigger_area"),
    area: text("area").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Member's own history and version counting.
    index("stance_changes_pair_idx").on(t.questionId, t.userId, t.id),
    // /settings/stances, first stance metrics, and member deletion.
    index("stance_changes_user_idx").on(t.userId, t.createdAt),
    // Weekly metrics.
    index("stance_changes_created_idx").on(t.createdAt),
    // The trigger post: deleting a post sets trigger_entry_id to null on its changes (ON DELETE SET NULL), and the foreign key check looks the rows up by it.
    index("stance_changes_trigger_idx").on(t.triggerEntryId),
    check("stance_changes_from_check", oneOf(t.fromPosition, POSITIONS)),
    check("stance_changes_to_check", oneOf(t.toPosition, POSITIONS)),
    // Append only on change; reject equal values or rows with both values null.
    check("stance_changes_moves_check", sql`${t.fromPosition} is distinct from ${t.toPosition}`),
    check("stance_changes_trigger_area_check", oneOf(t.triggerArea, AREAS)),
    check("stance_changes_area_check", oneOf(t.area, AREAS)),
  ],
);

// Roles: operator (lang null) and moderator per source language (lang is the assigned language).
// OPERATOR_EMAILS is authoritative for operators. Insert rows at login/session reads; remove unlisted rows at startup (syncOperatorRoles in roles.server.ts).
// Rows support queries and records. Determine operator status from the environment variable on every request.
// (user_id, role, lang) is unique. For operators, treat null lang as '' to enforce uniqueness; ordinary unique indexes permit duplicate NULLs.
export const roles = pgTable(
  "roles",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // "operator" | "moderator"
    lang: text("lang"),
    // Appointing user (null for operator rows). Retain the appointment record even after deleting the appointing operator's user.
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("roles_user_role_lang_unique").on(t.userId, t.role, sql`coalesce(${t.lang}, '')`),
    index("roles_role_lang_idx").on(t.role, t.lang),
    check("roles_role_check", oneOf(t.role, ROLE_NAMES)),
    check("roles_lang_check", sql`(${t.role} = 'operator' and ${t.lang} is null) or (${t.role} = 'moderator' and ${t.lang} is not null and ${oneOf(t.lang, LANGS)})`),
  ],
);

// Entry reports (mistranslation reports use translation_reports). Unique (entry_id, reporter_id) prevents one person reporting the same entry twice.
// status: open | resolved (handled by an action) | dismissed (including automatic closure after entry deletion).
// Do not expose the reporter in moderator screens or public records.
export const reports = pgTable(
  "reports",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint("entry_id", { mode: "number" }).references(() => entries.id),
    villageId: text("village_id").references(() => villages.id),
    chatMessageId: text("chat_message_id").references(() => chatMessages.id),
    avatarUserId: text("avatar_user_id").references(() => user.id),
    avatarMediaId: text("avatar_media_id").references(() => media.id, { onDelete: "set null" }),
    iconMediaId: text("icon_media_id").references(() => media.id, { onDelete: "set null" }),
    villageTarget: text("village_target").$type<"information" | "icon">().notNull().default("information"),
    displayNameUserId: text("display_name_user_id").references(() => user.id),
    displayNamesReported: jsonb("display_names_reported").$type<{ displayName: string | null; displayNameLatin: string | null }>(),
    // Frozen routing metadata avoids reading private evidence while selecting queue pages.
    chatLang: text("chat_lang"),
    chatAuthorId: text("chat_author_id").references(() => user.id, { onDelete: "set null" }),
    reporterId: text("reporter_id")
      .references(() => user.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    note: text("note").notNull().default(""),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    aiPriority: text("ai_priority"),
    aiAssessment: jsonb("ai_assessment").$type<{ en: string; ja: string }>(),
    aiModel: text("ai_model"),
    aiTriagedAt: timestamp("ai_triaged_at", { withTimezone: true }),
    // Handler and time. handled_by is null for automatic closure on entry deletion.
    handledBy: text("handled_by").references(() => user.id),
    handledAt: timestamp("handled_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("reports_entry_reporter_unique").on(t.entryId, t.reporterId),
    // /mod unresolved listing, oldest first.
    index("reports_open_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.status} = 'open'`),
    // Numbered moderation cards retain aggregate ordering; cover the narrow
    // grouping pass instead of scanning notes and assessment payloads.
    index("reports_handled_group_idx").on(t.entryId, t.villageId, t.chatMessageId, t.createdAt, t.handledAt)
      .where(sql`${t.status} <> 'open'`),
    uniqueIndex("reports_village_reporter_open_unique").on(t.villageId, t.reporterId, t.villageTarget).where(sql`${t.status} = 'open' AND ${t.villageId} IS NOT NULL`),
    uniqueIndex("reports_chat_reporter_unique").on(t.chatMessageId, t.reporterId).where(sql`${t.chatMessageId} IS NOT NULL`),
    uniqueIndex("reports_display_name_reporter_open_unique").on(t.displayNameUserId, t.reporterId).where(sql`${t.status} = 'open' AND ${t.displayNameUserId} IS NOT NULL`),
    uniqueIndex("reports_avatar_reporter_open_unique").on(t.avatarUserId, t.reporterId).where(sql`${t.status} = 'open' AND ${t.avatarUserId} IS NOT NULL`),
    index("reports_icon_media_idx").on(t.iconMediaId).where(sql`${t.iconMediaId} IS NOT NULL`),
    index("reports_avatar_media_idx").on(t.avatarMediaId).where(sql`${t.avatarMediaId} IS NOT NULL`),
    check("reports_target_check", sql`(${t.entryId} IS NOT NULL)::int + (${t.villageId} IS NOT NULL)::int + (${t.chatMessageId} IS NOT NULL)::int + (${t.displayNameUserId} IS NOT NULL)::int + (${t.avatarUserId} IS NOT NULL)::int = 1`),
    check("reports_village_target_check", oneOf(t.villageTarget, ["information", "icon"])),
    check("reports_chat_lang_check", sql`(${t.chatMessageId} IS NULL AND ${t.chatLang} IS NULL AND ${t.chatAuthorId} IS NULL) OR (${t.chatMessageId} IS NOT NULL AND ${t.chatLang} IS NOT NULL AND ${oneOf(t.chatLang, LANGS)})`),
    check("reports_ai_priority_check", sql`${t.aiPriority} is null or ${oneOf(t.aiPriority, ["urgent", "normal", "low"])}`),
    check("reports_reason_check", oneOf(t.reason, REPORT_REASONS)),
    check("reports_status_check", oneOf(t.status, REPORT_STATUSES)),
  ],
);

// Report evidence can be pruned independently of the report's status and identity.
export const villageReportSnapshots = pgTable("village_report_snapshots", {
  reportId: bigint("report_id", { mode: "number" }).primaryKey().references(() => reports.id, { onDelete: "cascade" }),
  name: text("name"),
  description: text("description"),
  slug: text("slug"),
  prunedAt: timestamp("pruned_at", { withTimezone: true }),
});

// One frozen first-report version per message. Routing metadata survives body pruning.
export const chatReportSnapshots = pgTable("chat_report_snapshots", {
  messageId: text("message_id").primaryKey().references(() => chatMessages.id),
  body: text("body"),
  lang: text("lang").notNull(),
  authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
  authorHandle: text("author_handle").notNull(),
  messageCreatedAt: timestamp("message_created_at", { withTimezone: true }).notNull(),
  createdSeq: bigint("created_seq", { mode: "number" }).notNull(),
  changedSeq: bigint("changed_seq", { mode: "number" }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  prunedAt: timestamp("pruned_at", { withTimezone: true }),
}, t => [check("chat_report_snapshots_lang_check", oneOf(t.lang, LANGS))]);

export const chatTranslationReports = pgTable("chat_translation_reports", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  messageId: text("message_id").notNull().references(() => chatMessages.id),
  reporterId: text("reporter_id").references(() => user.id, { onDelete: "set null" }),
  lang: text("lang").notNull(),
  sourceLang: text("source_lang").notNull(),
  sourceHash: text("source_hash").notNull(),
  translationHash: text("translation_hash").notNull(),
  original: text("original"),
  translation: text("translation"),
  note: text("note"),
  createdSeq: bigint("created_seq", { mode: "number" }).notNull(),
  changedSeq: bigint("changed_seq", { mode: "number" }).notNull(),
  status: text("status").$type<"retry" | "open" | "resolved" | "dismissed">().notNull(),
  retryAttemptedAt: timestamp("retry_attempted_at", { withTimezone: true }),
  handledBy: text("handled_by").references(() => user.id, { onDelete: "set null" }),
  handledAt: timestamp("handled_at", { withTimezone: true }),
  correctedAt: timestamp("corrected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  prunedAt: timestamp("pruned_at", { withTimezone: true }),
}, t => [
  uniqueIndex("chat_translation_reports_reporter_unique").on(t.messageId, t.lang, t.reporterId, t.translationHash),
  index("chat_translation_reports_target_idx").on(t.messageId, t.lang),
  index("chat_translation_reports_queue_idx").on(t.status, t.lang, t.createdAt),
  check("chat_translation_reports_lang_check", oneOf(t.lang, LANGS)),
  check("chat_translation_reports_source_lang_check", oneOf(t.sourceLang, LANGS)),
  check("chat_translation_reports_status_check", oneOf(t.status, ["retry", "open", "resolved", "dismissed"])),
]);

// Successful private reads only; never store message bodies in this audit trail.
export const chatAccessLog = pgTable("chat_access_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  readerId: text("reader_id").references(() => user.id, { onDelete: "set null" }),
  readerHandle: text("reader_handle").notNull(),
  readerKind: text("reader_kind").notNull().default("human"),
  reportId: bigint("report_id", { mode: "number" }).references(() => reports.id),
  appealId: bigint("appeal_id", { mode: "number" }).references((): AnyPgColumn => appeals.id),
  translationReportId: bigint("translation_report_id", { mode: "number" }).references(() => chatTranslationReports.id),
  villageId: text("village_id").notNull().references(() => villages.id),
  kind: text("kind").notNull(),
  // Expanded window bounds; ranges and versions identify the actual payload of this read.
  fromSeq: bigint("from_seq", { mode: "number" }).notNull(),
  toSeq: bigint("to_seq", { mode: "number" }).notNull(),
  // Actual versions returned, including the original snapshot when opening evidence.
  ranges: jsonb("ranges").$type<Array<{ from: number; to: number }>>().notNull(),
  versions: jsonb("versions").$type<Array<{ id: string; createdSeq: number; changedSeq: number; snapshot?: boolean }>>().notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("chat_access_log_created_idx").on(t.createdAt.desc(), t.id.desc()),
  index("chat_access_log_report_idx").on(t.reportId),
  index("chat_access_log_appeal_idx").on(t.appealId),
  check("chat_access_log_reader_check", sql`${t.readerKind} = 'human' OR (${t.readerKind} = 'ai' AND ${t.readerId} IS NULL)`),
  check("chat_access_log_case_check", sql`(${t.reportId} IS NOT NULL)::int + (${t.appealId} IS NOT NULL)::int + (${t.translationReportId} IS NOT NULL)::int = 1`),
  check("chat_access_log_kind_check", oneOf(t.kind, ["snapshot", "context"])),
  check("chat_access_log_range_check", sql`${t.fromSeq} >= 0 AND ${t.toSeq} >= ${t.fromSeq}`),
]);

// Moderation history. action: hide | unhide | suspend | unsuspend | dismiss_report | delete | restore | exclude_reactions | include_reactions | fix_entry | unfix_entry. reason is the category; note is a short explanation
// shown to the subject but omitted from public records. actor_id identifies the person who took the action and is also omitted from public records.
// For suspend, until is the required deadline. report_id identifies the underlying report, used to check suspension authority.
export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    action: text("action").notNull(),
    targetEntryId: bigint("target_entry_id", { mode: "number" }).references((): AnyPgColumn => entries.id),
    targetUserId: text("target_user_id").references(() => user.id),
    avatarMediaIdBefore: text("avatar_media_id_before").references(() => media.id, { onDelete: "set null" }),
    iconMediaIdBefore: text("icon_media_id_before").references(() => media.id, { onDelete: "set null" }),
    displayNamesBefore: jsonb("display_names_before").$type<{ displayName: string | null; displayNameLatin: string | null }>(),
    targetVillageId: text("target_village_id").references(() => villages.id),
    targetChatMessageId: text("target_chat_message_id").references(() => chatMessages.id),
    targetMediaId: text("target_media_id").references(() => media.id),
    villageEventId: bigint("village_event_id", { mode: "number" }).references(() => villageEvents.id),
    reason: text("reason").notNull(),
    note: text("note").notNull().default(""),
    actorId: text("actor_id").references(() => user.id),
    automatic: boolean("automatic").notNull().default(false),
    reportId: bigint("report_id", { mode: "number" }).references(() => reports.id, { onDelete: "set null" }),
    until: timestamp("until", { withTimezone: true }),
    // For fix_entry, the revision preserving title/body immediately before the edit (entry_revisions.id). Restore it when the appeal succeeds.
    revisionId: bigint("revision_id", { mode: "number" }).references(() => entryRevisions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Public records, newest first.
    index("moderation_actions_created_idx").on(t.createdAt.desc(), t.id.desc()),
    index("moderation_actions_entry_idx").on(t.targetEntryId),
    index("moderation_actions_user_idx").on(t.targetUserId),
    index("moderation_actions_icon_media_idx").on(t.iconMediaIdBefore).where(sql`${t.iconMediaIdBefore} IS NOT NULL`),
    index("moderation_actions_avatar_media_idx").on(t.avatarMediaIdBefore).where(sql`${t.avatarMediaIdBefore} IS NOT NULL`),
    index("moderation_actions_chat_idx").on(t.targetChatMessageId, t.id.desc()).where(sql`${t.targetChatMessageId} IS NOT NULL`),
    check("moderation_actions_actor_check", sql`(${t.automatic} = false AND ${t.actorId} IS NOT NULL) OR (${t.automatic} = true AND ${t.actorId} IS NULL AND ${t.action} IN ('hide', 'hide_chat') AND ${t.reason} = 'spam')`),
    check("moderation_actions_action_check", oneOf(t.action, MODERATION_ACTIONS)),
    check("moderation_actions_reason_check", oneOf(t.reason, REPORT_REASONS)),
    // Suspensions have deadlines.
    check("moderation_actions_suspend_until_check", sql`${t.action} <> 'suspend' or ${t.until} is not null`),
    // Editing a pinned question requires a revision to restore.
    check("moderation_actions_fix_village_event_check", sql`${t.action} <> 'fix_village' or ${t.villageEventId} is not null`),
    check("moderation_actions_fix_revision_check", sql`${t.action} <> 'fix_entry' or ${t.revisionId} is not null`),
    // Entry actions require an entry; member actions require a member. An action without either subject cannot be handled in public records or reversals.
    check(
      "moderation_actions_target_check",
      sql`(((((${oneOf(t.action, ENTRY_ACTIONS)} and ${t.targetEntryId} is not null) or (${oneOf(t.action, MEMBER_ACTIONS)} and ${t.targetUserId} is not null)) and ${t.targetVillageId} is null and ${t.targetChatMessageId} is null) or (${oneOf(t.action, VILLAGE_ACTIONS)} and ${t.targetVillageId} is not null and ${t.targetEntryId} is null and ${t.targetUserId} is null and ${t.targetChatMessageId} is null) or (${oneOf(t.action, CHAT_ACTIONS)} and ${t.targetChatMessageId} is not null and ${t.targetEntryId} is null and ${t.targetUserId} is null and ${t.targetVillageId} is null)) and ${t.targetMediaId} is null) or (${t.action} = 'delete_media' and ${t.targetMediaId} is not null and ${t.targetEntryId} is null and ${t.targetUserId} is null and ${t.targetVillageId} is null and ${t.targetChatMessageId} is null)`,
    ),
  ],
);

// Appeals: subjects of hide/delete/suspend (entry authors or suspended members) may appeal once per action. Unique (action_id, appellant_id).
// A moderator other than the action's actor (any assigned language) or an operator reviews it. Record the reviewer, review time, and decision_note.
// status: open | upheld | overturned (record the opposing action in the same operation when overturning).
export const appeals = pgTable(
  "appeals",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actionId: bigint("action_id", { mode: "number" })
      .notNull()
      .references(() => moderationActions.id),
    appellantId: text("appellant_id")
      .references(() => user.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    // For overturned, whether the action was actually reversed. False if its effect had already ended, leaving nothing to reverse. Null for upheld.
    reversed: boolean("reversed"),
  },
  (t) => [
    uniqueIndex("appeals_action_appellant_unique").on(t.actionId, t.appellantId),
    // /mod/appeals pending reviews, oldest first.
    index("appeals_open_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.status} = 'open'`),
    check("appeals_status_check", oneOf(t.status, APPEAL_STATUSES)),
  ],
);

// In-app notifications; emailed_at tracks email delivery. Create reply_to_topic/reply_to_reply in the reply's transaction
// with no self-notification and at most one per recipient per reply. moderation/appeal_decided omit the action's actor (actor_id null).
// entry_id: the reply for reply notifications; the affected entry for moderation (null for member actions). action_id: the moderation action.
export const notifications = pgTable(
  "notifications",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    translationReportId: bigint("translation_report_id", { mode: "number" }).references(() => translationReports.id, { onDelete: "cascade" }),
    entryId: bigint("entry_id", { mode: "number" }).references(() => entries.id),
    // The first reply of a followed-thread notification; merging keeps it unchanged.
    firstEntryId: bigint("first_entry_id", { mode: "number" }).references(() => entries.id),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    actionId: bigint("action_id", { mode: "number" }).references(() => moderationActions.id, { onDelete: "set null" }),
    // appeal_decided: the appeal whose result is being announced.
    appealId: bigint("appeal_id", { mode: "number" }).references(() => appeals.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
    // Time included in immediate or daily email. Set even for omitted notifications (such as hidden/deleted replies), to avoid checking them repeatedly.
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    // The topic the notification is about. Required for followed_thread (the unit that unread notifications are merged by); the other content kinds fill it too (to find the topic
    // without reading the entry). Rows made before the follow feature keep null (the topic is then found through entry_id).
    threadId: bigint("thread_id", { mode: "number" }).references(() => entries.id),
    // followed_thread: how many replies are merged into this row. 1 for every other kind.
    mergedCount: integer("merged_count").notNull().default(1),
    villageId: text("village_id").references(() => villages.id, { onDelete: "set null" }),
    villageInviteId: text("village_invite_id").references(() => villageInvites.id, { onDelete: "set null" }),
    villageReason: text("village_reason"),
    chatMessageId: text("chat_message_id").references(() => chatMessages.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("notifications_translation_report_unique").on(t.translationReportId),
    check("notifications_translation_report_check", sql`(${t.kind} = 'translation_report_result') = (${t.translationReportId} IS NOT NULL)`),
    index("notifications_user_idx").on(t.userId, t.createdAt.desc(), t.id.desc()),
    index("notifications_chat_message_idx").on(t.chatMessageId).where(sql`${t.chatMessageId} is not null`),
    // Unread count in the header.
    index("notifications_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
    // Daily digest candidates not yet processed for email.
    index("notifications_unemailed_idx")
      .on(t.userId, t.createdAt)
      .where(sql`${t.emailedAt} is null`),
    check("notifications_kind_check", oneOf(t.kind, NOTIFICATION_KINDS)),
    check("notifications_followed_thread_check", sql`${t.kind} <> 'followed_thread' OR (${t.threadId} IS NOT NULL AND ${t.entryId} IS NOT NULL)`),
    check("notifications_merged_count_check", sql`${t.mergedCount} >= 1`),
    // At most one unread followed_thread per (member, topic): the target of the merging upsert (app/lib/notifications.server.ts).
    uniqueIndex("notifications_followed_unread_unique")
      .on(t.userId, t.threadId)
      .where(sql`${t.kind} = 'followed_thread' AND ${t.readAt} IS NULL`),
  ],
);

// A private watermark per list, without recording which individual topics were opened.
// The check bounds the shape only; the route decides which languages are enabled, so adding a language needs no migration.
export const listSeen = pgTable("list_seen", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.userId, t.scope] }),
  index("list_seen_member_order_idx").on(t.userId, t.updatedAt.desc(), t.scope),
  check("list_seen_scope_check", sql`length(${t.scope}) <= 67 and ${t.scope} ~ '^(/|/a/[A-Za-z]{2,3}(-[A-Za-z]+)?/?|/v/[a-z0-9]+(-[a-z0-9]+)*/?)$'`),
]);

// Private reading list; no copy of a post and no public activity signal.
export const savedTopics = pgTable("saved_topics", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  topicId: bigint("topic_id", { mode: "number" }).notNull().references(() => entries.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.userId, t.topicId] }),
  index("saved_topics_member_order_idx").on(t.userId, t.createdAt.desc(), t.topicId.desc()),
  index("saved_topics_topic_idx").on(t.topicId),
]);

// Following a topic (a thread or a question; the id is never a reply's). A member's own topics and the topics they replied to are followed automatically; a topic the member took
// off stays as `unfollowed` (the record that stops the automatic follow). Choosing a stance does not follow. No backfill: it starts with new posts. Members are not followed.
export const follows = pgTable(
  "follows",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: bigint("thread_id", { mode: "number" })
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The leading user_id column also serves "the follows of one member" (/following).
    primaryKey({ columns: [t.userId, t.threadId] }),
    // The recipients of a new reply: the members who follow the topic now.
    index("follows_thread_following_idx")
      .on(t.threadId)
      .where(sql`${t.state} = 'following'`),
    check("follows_state_check", oneOf(t.state, FOLLOW_STATES)),
  ],
);

// Mentions that have been told: one row per (post, member), append-only. A member is told once per post: removing a mention in an edit and writing it again does
// not tell again, and an edit that adds a new member tells only that member. A member who gets a reply notification for the same post is recorded without a `mention`
// notification. The number of rows of a post is what the limit of 10 members counts (MENTION_NOTIFY_LIMIT).
export const notifiedMentions = pgTable(
  "notified_mentions",
  {
    entryId: bigint("entry_id", { mode: "number" })
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.userId] }),
    // The foreign key of the member (deleting a member).
    index("notified_mentions_user_idx").on(t.userId),
  ],
);

// The first draw for a question's UTC day survives new replies and later reads.
// Removed or no-longer-eligible replies are filtered without refilling the draw.
export const reasonSelections = pgTable(
  "reason_selections",
  {
    questionId: bigint("question_id", { mode: "number" }).notNull().references(() => entries.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    pick: jsonb("pick").$type<ReasonPick>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.questionId, t.day] }), check("reason_selections_day_check", sql`${t.day} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`)],
);

// Evaluation data contains only the versioned public examples, never member posts.
export const translationEvalRuns = pgTable("translation_eval_runs", {
  id: text("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  setVersion: text("set_version").notNull(),
  setHash: text("set_hash").notNull(),
  translator: jsonb("translator").$type<{ provider: string; model: string; thinking: string; promptVersion: string }>().notNull(),
  glossaryVersion: text("glossary_version"),
  // Freeze the active hints so a later glossary edit does not change the run's provenance.
  glossary: jsonb("glossary").$type<unknown[]>().notNull(),
  judge: jsonb("judge").$type<{ provider: string; model: string; thinking: string; promptVersion: string }>().notNull(),
  sameProvider: boolean("same_provider").notNull(),
  calls: integer("calls").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsdMicro: bigint("cost_usd_micro", { mode: "number" }).notNull().default(0),
  status: text("status").$type<"running" | "completed" | "failed">().notNull().default("running"),
}, t => [index("translation_eval_runs_started_idx").on(t.startedAt), check("translation_eval_runs_status_check", oneOf(t.status, ["running", "completed", "failed"]))]);

export const translationEvalTexts = pgTable("translation_eval_texts", {
  runId: text("run_id").notNull().references(() => translationEvalRuns.id, { onDelete: "cascade" }),
  caseId: text("case_id").notNull(),
  from: text("from_lang").notNull(),
  to: text("to_lang").notNull(),
  category: text("category").notNull(),
  source: text("source").notNull(),
  translation: text("translation"),
  flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
  error: text("error"),
}, t => [primaryKey({ columns: [t.runId, t.caseId, t.to] })]);

export const translationEvalPoints = pgTable("translation_eval_points", {
  runId: text("run_id").notNull().references(() => translationEvalRuns.id, { onDelete: "cascade" }),
  caseId: text("case_id").notNull(),
  to: text("to_lang").notNull(),
  checkId: text("check_id").notNull(),
  description: text("description").notNull(),
  kind: text("kind").notNull(),
  preserved: boolean("preserved").notNull(),
  severe: boolean("severe").notNull(),
  reason: text("reason").notNull(),
}, t => [primaryKey({ columns: [t.runId, t.caseId, t.to, t.checkId] }), check("translation_eval_points_severe_check", sql`not ${t.preserved} or not ${t.severe}`)]);

// Observation starts at migration time; do not invent historical counts or corrections.
export const qualityMetricState = pgTable("quality_metric_state", {
  id: integer("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("quality_metric_state_singleton", sql`${t.id} = 1`)]);
export const translationSignalCounts = pgTable("translation_signal_counts", {
  scope: text("scope").$type<"post" | "chat">().notNull(),
  from: text("from_lang").notNull(),
  to: text("to_lang").notNull(),
  generated: integer("generated").notNull().default(0),
}, t => [primaryKey({ columns: [t.scope, t.from, t.to] }), check("translation_signal_counts_scope", oneOf(t.scope, ["post", "chat"])), check("translation_signal_counts_nonnegative", sql`${t.generated} >= 0`)]);

// Keep only counts after publication, tied to the post's deletion lifecycle. No draft text or member identifier.
export const aiDraftEdits = pgTable("ai_draft_edits", {
  entryId: bigint("entry_id", { mode: "number" }).primaryKey().references(() => entries.id, { onDelete: "cascade" }),
  source: text("source").$type<"api" | "mcp">().notNull(),
  beforeChars: integer("before_chars").notNull(),
  afterChars: integer("after_chars").notNull(),
  changedChars: integer("changed_chars").notNull(),
  comparisonChars: integer("comparison_chars").notNull(),
  changed: boolean("changed").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("ai_draft_edits_source", oneOf(t.source, ["api", "mcp"]))]);

// Browser installations are independent of authentication sessions: a copied
// session cookie must not merge two browser storage areas.
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: text("id").primaryKey(),
  browserSecretHash: text("browser_secret_hash").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull().default(1),
  endpoint: text("endpoint"),
  p256dh: text("p256dh"),
  auth: text("auth"),
  vapidPublicKey: text("vapid_public_key").notNull(),
  browser: text("browser").notNull(),
  os: text("os").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  authorizingSessionId: text("authorizing_session_id").notNull(),
  authorizedUntil: timestamp("authorized_until", { withTimezone: true }).notNull(),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastAcceptedAt: timestamp("last_accepted_at", { withTimezone: true }),
  failures: integer("failures").notNull().default(0),
  stoppedReason: text("stopped_reason"),
}, t => [uniqueIndex("push_subscriptions_endpoint_unique").on(t.endpoint), index("push_subscriptions_user_idx").on(t.userId),
  check("push_subscriptions_generation_check", sql`${t.generation} > 0`), check("push_subscriptions_failures_check", sql`${t.failures} >= 0`)]);

// A durable row keeps the uniqueness guarantee after the queue job completes.
export const pushDeliveries = pgTable("push_deliveries", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  notificationId: integer("notification_id").notNull().references(() => notifications.id, { onDelete: "cascade" }),
  subscriptionId: text("subscription_id").notNull().references(() => pushSubscriptions.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notificationIds: jsonb("notification_ids").$type<number[]>(),
  batchId: integer("batch_id"),
  attemptToken: text("attempt_token"),
  attemptStartedAt: timestamp("attempt_started_at", { withTimezone: true }),
}, t => [uniqueIndex("push_deliveries_notice_registration_unique").on(t.notificationId, t.subscriptionId, t.generation),
  index("push_deliveries_user_idx").on(t.userId), index("push_deliveries_subscription_idx").on(t.subscriptionId),
  index("push_deliveries_pending_idx").on(t.subscriptionId, t.generation, t.createdAt).where(sql`${t.completedAt} is null`)]);

// Daily anonymous buckets only: never store an article, person, device, IP,
// raw referrer or user agent. There are no per-read records or identity joins.
export const readingCounts = pgTable("reading_counts", {
  day: date("day").notNull(),
  method: text("method").notNull().$type<typeof READING_METHODS[number]>(),
  sourceLang: text("source_lang").notNull().$type<SourceLang>(),
  readLang: text("read_lang").notNull().$type<SourceLang>(),
  source: text("source").notNull().$type<typeof READING_SOURCES[number]>(),
  count: bigint("count", { mode: "number" }).notNull().default(0),
}, t => [
  primaryKey({ columns: [t.day, t.method, t.sourceLang, t.readLang, t.source] }),
  check("reading_counts_method_check", oneOf(t.method, READING_METHODS)),
  check("reading_counts_source_check", oneOf(t.source, READING_SOURCES)),
  check("reading_counts_source_lang_check", oneOf(t.sourceLang, SOURCE_LANGS)),
  check("reading_counts_read_lang_check", oneOf(t.readLang, SOURCE_LANGS)),
  check("reading_counts_count_check", sql`${t.count} >= 0`),
  check("reading_counts_machine_source_check", sql`${t.method} = 'browser' or ${t.source} = 'none'`),
]);
