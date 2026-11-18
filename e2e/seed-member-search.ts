import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { profiles } from "../app/lib/db/schema";
import { updateDisplayNames } from "../app/lib/display-names.server";

export async function seedMemberSearch(db: Db) {
  const [target] = await db.select().from(profiles).where(eq(profiles.handle, "zmember_search_target"));
  const saved = await updateDisplayNames(db, target.userId, "風見すみれ", "Sumire Kazami");
  if (!saved.ok) throw Error(saved.error);
}
