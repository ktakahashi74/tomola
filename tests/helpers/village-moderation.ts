import { eq } from "drizzle-orm";
import { reports, villages } from "~/lib/db/schema";
import { moderateVillage, villageModerationVersion } from "~/lib/village-moderation.server";

// Existing service tests use a freshly opened form by default. Stale-form tests
// supply the earlier token explicitly, together with all browser form fields.
export async function moderateWithCurrentVersion(db: Parameters<typeof moderateVillage>[0], actor: Parameters<typeof moderateVillage>[1], input: Omit<Parameters<typeof moderateVillage>[2], "version"> & { version?: unknown }, opts: Parameters<typeof moderateVillage>[3] = {}) {
  const [target] = input.slugTarget !== undefined
    ? await db.select({ id: villages.id }).from(villages).where(eq(villages.slug, input.slugTarget))
    : await db.select({ id: reports.villageId }).from(reports).where(eq(reports.id, input.reportId ?? 0));
  const version = input.version === undefined && target?.id ? await villageModerationVersion(db, target.id) : input.version;
  return moderateVillage(db, actor, { ...input, version }, opts);
}
