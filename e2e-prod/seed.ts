// Seed production-build browser tests (e2e-prod/): create invitations for the email arguments and print one invitation URL per line to stdout.
// Run before starting the production build, against DATABASE_URL or PGLITE_DATA_DIR. For PostgreSQL, run pnpm db:migrate first.
import { closeDb, getDb } from "../app/lib/db/client.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";
import { seedMembers } from "../e2e/seed-members";
import { PROD_MEMBERS } from "./member-fixtures";
import { seedEarlyActions } from "../e2e/seed-early-actions";

const db = await getDb();
await seedMembers(db, process.env.E2E_SEED_DIR!, process.env.BETTER_AUTH_URL!, PROD_MEMBERS);
await seedEarlyActions(db, process.env.E2E_SEED_DIR!);
for (const email of process.argv.slice(2)) {
  const { token } = await createInvitation(db, { email });
  console.log(inviteUrl(token));
}
await closeDb(db);
process.exit(0);
