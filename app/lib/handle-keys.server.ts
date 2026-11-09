import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { profiles } from "~/lib/db/schema";
import { handleKey } from "~/lib/handles";

// Recompute profiles.handle_key using the app's handleKey (app/lib/handles.ts). `pnpm db:migrate` calls this after migrations.
// Migration 0025 backfills existing keys with PostgreSQL normalize/lower. lower depends on database collation (LC_CTYPE, ICU locale),
// potentially differing from the app's per-character lowercase: 「İ」 becomes 「i」 plus a combining dot under an ICU locale. Upgrading Node's ICU/Unicode
// can also change handleKey results. Mismatching rows prevent the unique index from detecting duplicate names, or existing names from conflicting with new registrations.
// The app's handleKey is authoritative. Correct only differing rows; if corrected keys collide, throw with the names rather than silently merging them.
export type RecomputedHandleKeys = { checked: number; fixed: string[] };

export class HandleKeyCollisionError extends Error {
  constructor(readonly handles: string[]) {
    super(
      `handle_key collision: these display names are the same after NFKC normalization and lowercasing: ${handles.map((h) => `"${h}"`).join(", ")}. ` +
        `Rename all but one of them (UPDATE profiles SET handle = '<new name>' WHERE handle = '<old name>') and run the migration again.`,
    );
    this.name = "HandleKeyCollisionError";
  }
}

export async function recomputeHandleKeys(db: Db): Promise<RecomputedHandleKeys> {
  const rows = await db.select({ userId: profiles.userId, handle: profiles.handle, key: profiles.handleKey }).from(profiles);
  const wanted = rows.map((r) => ({ ...r, wanted: handleKey(r.handle) }));
  // First find all corrected keys colliding with other rows, both changed and unchanged.
  const byKey = new Map<string, string[]>();
  for (const r of wanted) byKey.set(r.wanted, [...(byKey.get(r.wanted) ?? []), r.handle]);
  const colliding = [...byKey.values()].filter((handles) => handles.length > 1);
  if (colliding.length > 0) throw new HandleKeyCollisionError(colliding.flat());
  const stale = wanted.filter((r) => r.key !== r.wanted);
  if (stale.length === 0) return { checked: rows.length, fixed: [] };
  await db.transaction(async (tx) => {
    // Unique indexes check each row individually. Avoid temporary collisions during swaps (A's new key equals B's old key) by assigning distinct temporary values first
    // using 「~」 and 「:」, which cannot appear in keys under handle rules permitting only letters, digits, combining marks, _ . -.
    for (const r of stale) await tx.update(profiles).set({ handleKey: `~migrate:${r.userId}` }).where(eq(profiles.userId, r.userId));
    for (const r of stale) await tx.update(profiles).set({ handleKey: r.wanted }).where(eq(profiles.userId, r.userId));
  });
  return { checked: rows.length, fixed: stale.map((r) => r.handle) };
}
