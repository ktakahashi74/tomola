import type { Db } from "../app/lib/db/client.server";
import { villages } from "../app/lib/db/schema";
import { villagesEnabled } from "../app/lib/villages-enabled.server";

export async function seedVillageSearch(db: Db) {
  if (!villagesEnabled()) return;
  await db.insert(villages).values({ slug: "alpine-geometry", kind: "open", name: "Alpine geometry circle", description: "A place to discuss shapes and proofs.", sourceLang: "en" });
}
