import { isEnabledLang } from "./enabled-langs.server";
import { safeErrorText } from "~/lib/error-text.server";
import { and, asc, eq, ilike, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { profiles, roles, user } from "~/lib/db/schema";
import { isLang, type Lang } from "~/lib/languages";
import { isOperatorEmail, operatorEmails } from "~/lib/operators.server";

// Roles and their language scope.
// - Operators: users in OPERATOR_EMAILS, checked against environment emails on every request; environment is canonical. roles.operator rows
//   support queries/history: insert on login/session load via requireMember; remove absent operators at startup via syncOperatorRoles.
// - Moderators: appointed per original language; unopened source languages are shared by every moderator.

// UI/action scope: operators cover all languages; others only assigned langs.
export type ModScope = { operator: boolean; langs: readonly Lang[] };

export const NO_SCOPE: ModScope = { operator: false, langs: [] };

// Whether moderator in any language or operator, permitting /mod access.
export const isModerator = (scope: ModScope): boolean => scope.operator || scope.langs.length > 0;

// Chat and translation-target permissions retain their assigned-language boundary.
export const inLanguageScope = (scope: ModScope, lang: string): boolean => scope.operator || (scope.langs as readonly string[]).includes(lang);

// Original posts in unopened languages are shared by all moderators.
export const inScope = (scope: ModScope, lang: string): boolean => inLanguageScope(scope, lang) || (scope.langs.length > 0 && !isEnabledLang(lang));

// Viewer user/scope for deciding whether hidden post content may be shown (app/lib/moderation-view.ts).
export type Viewer = { userId: string; scope: ModScope };

// Resolve operator status from environment emails every request; read moderator languages from roles rows.
export async function getModScope(db: Db, account: { id: string; email: string }, env: Record<string, string | undefined> = process.env): Promise<ModScope> {
  const operator = isOperatorEmail(account.email, env);
  const rows = await db
    .select({ lang: roles.lang })
    .from(roles)
    .where(and(eq(roles.userId, account.id), eq(roles.role, "moderator")))
    .orderBy(asc(roles.lang));
  return { operator, langs: rows.map((r) => r.lang).filter(isLang) };
}

// Hidden content is available only to its author, assigned-original-language moderators or operators. No viewer, e.g. twins, means hide it.
export function canSeeHidden(viewer: Viewer | null | undefined, entry: { authorId: string; lang: string }): boolean {
  return viewer != null && (viewer.userId === entry.authorId || inScope(viewer.scope, entry.lang));
}

export async function getViewer(db: Db, account: { id: string; email: string }): Promise<Viewer> {
  return { userId: account.id, scope: await getModScope(db, account) };
}

// Remember operator-row insertion per process and database, avoiding writes on every request.
const ensured = new WeakMap<Db, Set<string>>();

// Insert missing operator row for users in OPERATOR_EMAILS; no-op for nonoperators. Called on login/session load.
export async function ensureOperatorRow(db: Db, account: { id: string; email: string }, env: Record<string, string | undefined> = process.env): Promise<void> {
  if (!isOperatorEmail(account.email, env)) return;
  let seen = ensured.get(db);
  if (!seen) ensured.set(db, (seen = new Set()));
  if (seen.has(account.id)) return;
  await db.insert(roles).values({ userId: account.id, role: "operator", lang: null }).onConflictDoNothing();
  seen.add(account.id);
}

// Startup synchronization removes operator rows absent from OPERATOR_EMAILS and inserts listed existing users.
// Return removed/inserted counts.
export async function syncOperatorRoles(db: Db, env: Record<string, string | undefined> = process.env): Promise<{ removed: number; added: number }> {
  const listed = [...operatorEmails(env)];
  // Operator rows for emails removed from environment. Compare lower(email); operatorEmails is already lowercase.
  const stale = await db
    .delete(roles)
    .where(
      and(
        eq(roles.role, "operator"),
        inArray(
          roles.userId,
          db.select({ id: user.id }).from(user).where(listed.length > 0 ? notInArray(sql`lower(${user.email})`, listed) : sql`true`),
        ),
      ),
    )
    .returning({ id: roles.id });
  let added = 0;
  if (listed.length > 0) {
    const members = await db.select({ id: user.id }).from(user).where(inArray(sql`lower(${user.email})`, listed));
    if (members.length > 0) {
      const inserted = await db
        .insert(roles)
        .values(members.map((m) => ({ userId: m.id, role: "operator", lang: null })))
        .onConflictDoNothing()
        .returning({ id: roles.id });
      added = inserted.length;
    }
  }
  // Rows were reinserted, so discard remembered insertion state.
  ensured.delete(db);
  return { removed: stale.length, added };
}

const g = globalThis as { __tomolaRolesSynced?: boolean };

// Synchronize once on the first process request (app/root.tsx loader). Failure does not stop pages; next process retries.
export function syncOperatorRolesOnce(getDb: () => Promise<Db>): void {
  if (g.__tomolaRolesSynced) return;
  g.__tomolaRolesSynced = true;
  getDb()
    .then((db) => syncOperatorRoles(db))
    .catch((error) => {
      g.__tomolaRolesSynced = false;
      console.error("[roles] could not sync the operator roles:", safeErrorText(error));
    });
}

// reactionsExcluded: stances/Insightful (「なるほど」) excluded from counts by operator exclude_reactions.
export type MemberHit = { userId: string; handle: string; moderatorLangs: Lang[]; operator: boolean; suspendedUntil: Date | null; reactionsExcluded: boolean };

// Find members by display-name substring, case-insensitively, up to limit for operator /admin/roles.
export async function searchMembers(db: Db, query: string, opts: { limit?: number } = {}): Promise<MemberHit[]> {
  const q = query.trim();
  if (q === "") return [];
  // Escape LIKE metacharacters to search them literally.
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select({ userId: profiles.userId, handle: profiles.handle, email: user.email, suspendedUntil: profiles.suspendedUntil, reactionsExcludedAt: profiles.reactionsExcludedAt })
    .from(profiles)
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(ilike(profiles.handle, pattern))
    .orderBy(asc(profiles.handle))
    .limit(opts.limit ?? 20);
  if (rows.length === 0) return [];
  const held = await db
    .select({ userId: roles.userId, lang: roles.lang })
    .from(roles)
    .where(and(eq(roles.role, "moderator"), inArray(roles.userId, rows.map((r) => r.userId))));
  return rows.map((r) => ({
    userId: r.userId,
    handle: r.handle,
    moderatorLangs: held.filter((h) => h.userId === r.userId).map((h) => h.lang).filter(isLang),
    operator: isOperatorEmail(r.email),
    // Only active suspension expiry; null after expiry.
    suspendedUntil: r.suspendedUntil !== null && r.suspendedUntil > new Date() ? r.suspendedUntil : null,
    reactionsExcluded: r.reactionsExcludedAt !== null,
  }));
}

export type ModeratorRow = { userId: string; handle: string | null; lang: Lang; grantedBy: string | null; grantedByHandle: string | null; createdAt: Date };

// Current moderators ordered by language/display name.
export async function listModerators(db: Db): Promise<ModeratorRow[]> {
  const granter = profiles;
  const rows = await db
    .select({ userId: roles.userId, handle: profiles.handle, lang: roles.lang, grantedBy: roles.grantedBy, createdAt: roles.createdAt })
    .from(roles)
    .leftJoin(profiles, eq(profiles.userId, roles.userId))
    .where(eq(roles.role, "moderator"))
    .orderBy(asc(roles.lang), asc(profiles.handle));
  const granters = new Map<string, string>();
  const ids = [...new Set(rows.map((r) => r.grantedBy).filter((v): v is string => v !== null))];
  if (ids.length > 0) {
    for (const r of await db.select({ userId: granter.userId, handle: granter.handle }).from(granter).where(inArray(granter.userId, ids))) granters.set(r.userId, r.handle);
  }
  return rows.flatMap((r) =>
    isLang(r.lang) ? [{ userId: r.userId, handle: r.handle, lang: r.lang, grantedBy: r.grantedBy, grantedByHandle: r.grantedBy ? (granters.get(r.grantedBy) ?? null) : null, createdAt: r.createdAt }] : [],
  );
}

export type RoleError = "invalid_lang" | "not_a_member";

// Appoint moderator per language; no-op added:false if already appointed. Requires membership/profile.
export async function grantModerator(
  db: Db,
  grantedBy: string,
  userId: string,
  lang: unknown,
  opts: { now?: Date } = {},
): Promise<{ ok: true; added: boolean } | { ok: false; error: RoleError }> {
  if (!isLang(lang)) return { ok: false, error: "invalid_lang" };
  const [member] = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, userId));
  if (!member) return { ok: false, error: "not_a_member" };
  const rows = await db
    .insert(roles)
    .values({ userId, role: "moderator", lang, grantedBy, createdAt: opts.now })
    .onConflictDoNothing()
    .returning({ id: roles.id });
  return { ok: true, added: rows.length > 0 };
}

// Remove moderator per language; no-op removed:false if not appointed.
export async function revokeModerator(db: Db, userId: string, lang: unknown): Promise<{ ok: true; removed: boolean } | { ok: false; error: "invalid_lang" }> {
  if (!isLang(lang)) return { ok: false, error: "invalid_lang" };
  const rows = await db
    .delete(roles)
    .where(and(eq(roles.userId, userId), eq(roles.role, "moderator"), eq(roles.lang, lang)))
    .returning({ id: roles.id });
  return { ok: true, removed: rows.length > 0 };
}
