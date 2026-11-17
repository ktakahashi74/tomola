// Seed production-build browser tests (e2e-prod/): create invitations for the email arguments and print one invitation URL per line to stdout.
// Run before starting the production build, against DATABASE_URL or PGLITE_DATA_DIR. For PostgreSQL, run pnpm db:migrate first.
import { closeDb, getDb } from "../app/lib/db/client.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";
import { seedMembers } from "../e2e/seed-members";
import { PROD_MEMBERS } from "./member-fixtures";
import { seedEarlyActions } from "../e2e/seed-early-actions";
import { account, user } from "../app/lib/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const db = await getDb();
await seedMembers(db, process.env.E2E_SEED_DIR!, process.env.BETTER_AUTH_URL!, PROD_MEMBERS);
await seedEarlyActions(db, process.env.E2E_SEED_DIR!);
if (process.env.E2E_GOOGLE_LOGIN === "1") {
  const [member] = await db.select({ id: user.id }).from(user).where(eq(user.email, "style_preloads_reader@example.com"));
  await db.insert(account).values({ id: randomUUID(), userId: member.id, providerId: "google", accountId: "browser-fixture-subject" });
}
for (const email of process.argv.slice(2)) {
  const { token } = await createInvitation(db, { email });
  console.log(inviteUrl(token));
}
await closeDb(db);
process.exit(0);
