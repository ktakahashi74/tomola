import { runCli } from "./cli";
import { safeErrorText } from "../app/lib/error-text.server.ts";
// Stop the development server first: PGlite cannot open the same data from multiple processes; the lock enforces this.
import { getOperatorDb as getDb } from "../app/lib/db/client.server";
import { parseEmail } from "../app/lib/email";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";

async function main() {
  const email = parseEmail(process.argv[2] ?? "");
  if (!email) {
    console.error("usage: pnpm invite <email>");
    process.exit(1);
  }
  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
  } catch (error) {
    // A running development server causes a lock error; no stack trace needed.
    console.error(safeErrorText(error));
    process.exit(1);
  }
  const { token } = await createInvitation(db, { email });
  // For local execution without NODE_ENV, an absent BETTER_AUTH_URL uses the development default http://localhost:5173, as before.
  console.log(inviteUrl(token, { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "development" }));
  process.exit(0);
}

process.exitCode = await runCli(main);
