import { runCli } from "./cli";
import { safeErrorText } from "../app/lib/error-text.server.ts";
import { eq } from "drizzle-orm";
import { closeDb, getOperatorDb as getDb } from "../app/lib/db/client.server";
import { user } from "../app/lib/db/schema";
import { parseEmail } from "../app/lib/email";
import { recoverPasskeys } from "../app/lib/auth/passkeys.server";

// Administrative CLI only. Independently verify the member's identity before running it and record the checks in the required explanation.
async function main() {
  const operatorEmail = parseEmail(process.argv[2] ?? "");
  const memberEmail = parseEmail(process.argv[3] ?? "");
  const note = process.argv[4] ?? "";
  if (!operatorEmail || !memberEmail || note.trim().length < 10) {
    console.error("usage: pnpm exec tsx scripts/recover-passkeys.ts <operator-email> <member-email> '<identity verification explanation>'");
    process.exitCode = 1;
  } else {
    const db = await getDb();
    try {
      const [operator] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.email, operatorEmail));
      const [member] = await db.select({ id: user.id }).from(user).where(eq(user.email, memberEmail));
      if (!operator || !member) throw new Error("Operator or member account not found");
      const result = await recoverPasskeys(db, operator, member.id, note);
      console.log(`Recovery permitted until ${result.expiresAt.toISOString()}. All sessions and old credentials were revoked; a notice is queued. The member must sign in by email and register within thirty minutes.`);
    } catch (error) { console.error(safeErrorText(error)); process.exitCode = 1; }
    finally { await closeDb(db); }
  }
}

process.exitCode = await runCli(main);
