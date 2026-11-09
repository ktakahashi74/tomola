import { eq } from "drizzle-orm";
import { closeDb, openPgDb, openPgliteDb, resolveDbConfig } from "../app/lib/db/client.server";
import { accountDeletions } from "../app/lib/db/schema";
import { AccountDeletionError, cancelAccountDeletion, completeAccountDeletion, deleteAccount, deletionVillages } from "../app/lib/account-delete.server";
import { handleKey } from "../app/lib/handles";
import { enqueue } from "../app/lib/jobs/queue.server";
import { SEND_ACCOUNT_DELETED_JOB } from "../app/lib/jobs/mail-kinds";
import { parseEmail } from "../app/lib/email";
import { runCli } from "./cli";

const usage = "Usage: delete-account status [REQUEST] | run USER --confirm-handle HANDLE [--posts keep|delete] [--village SLUG=end|member:HANDLE|transfer]... | retry REQUEST | cancel REQUEST | retry-mail REQUEST --email ADDRESS";
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["status", "run", "retry", "cancel", "retry-mail"].includes(command)) throw new Error(usage);
  const options = new Map<string, string>();
  const choices = new Map<string, string>();
  if (command === "run" || command === "retry-mail") {
    for (let i = 1; i < args.length; i += 2) {
      if (command === "run" && args[i] === "--village") {
        const match = /^([^=]+)=(end|transfer|member:.+)$/.exec(args[i + 1] ?? "");
        if (!match || choices.has(match[1])) throw new Error(usage);
        choices.set(match[1], match[2]);
        continue;
      }
      if (!args[i]?.startsWith("--") || !args[i + 1] || options.has(args[i])) throw new Error(usage);
      options.set(args[i], args[i + 1]);
    }
    const allowed = command === "run" ? ["--confirm-handle", "--posts"] : ["--email"];
    if (!args[0] || [...options.keys()].some(key => !allowed.includes(key))) throw new Error(usage);
    if (command === "run" && (!options.get("--confirm-handle") || !["keep", "delete"].includes(options.get("--posts") ?? "keep"))) throw new Error(usage);
    if (command === "retry-mail" && !parseEmail(options.get("--email") ?? "")) throw new Error(usage);
  } else if (command === "status" ? args.length > 1 : args.length !== 1) throw new Error(usage);
  const config = resolveDbConfig();
  const db = config.kind === "pg" ? await openPgDb(config.url) : await openPgliteDb(config.dataDir, { migrate: false });
  try {
    if (command === "run") {
      const owned = await deletionVillages(db, args[0]);
      if ([...choices.keys()].some(slug => !owned.some(village => village.slug === slug))) throw new Error("Unknown owned village slug");
      const decisions: Record<string, string> = {};
      for (const village of owned) {
        let choice = choices.get(village.slug ?? "");
        if (choice === "transfer" && !village.otherOwners || choice?.startsWith("member:") && village.otherOwners) throw new Error("Choose an available ownership action");
        if (choice?.startsWith("member:")) {
          const key = handleKey(choice.slice(7).trim().replace(/^@/, ""));
          const member = village.members.find(member => handleKey(member.handle) === key);
          if (!member) throw new Error("Choose a current village member");
          choice = `member:${member.id}`;
        }
        if (choice) decisions[village.id] = choice;
      }
      // A partial CLI selection keeps harmless defaults, but never guesses for a
      // sole-owned village shared with other members.
      const villages = choices.size ? Object.fromEntries(owned.map(village => [village.id, decisions[village.id] ?? (village.otherOwners ? "transfer" : village.members.length ? "" : "end")])) : undefined;
      try {
        console.log(JSON.stringify(await deleteAccount(db, args[0], { confirmation: options.get("--confirm-handle")!, posts: (options.get("--posts") ?? "keep") as "keep" | "delete", villages })));
      } catch (error) {
        if (!(error instanceof AccountDeletionError) || error.code !== "village_required") throw error;
        const current = await deletionVillages(db, args[0]);
        console.error(JSON.stringify({ error: error.code, villages: current.filter(village => error.villageIds.includes(village.id)).sort((a, b) => (a.slug ?? "").localeCompare(b.slug ?? "")).map(village => ({ name: village.name, slug: village.slug, members: village.members.length + 1 })) }));
        return 1;
      }
    }
    if (command === "retry") console.log(JSON.stringify(await completeAccountDeletion(db, args[0])));
    if (command === "cancel") await cancelAccountDeletion(db, args[0]);
    if (command === "retry-mail") {
      const [request] = await db.select().from(accountDeletions).where(eq(accountDeletions.id, args[0]));
      if (!request || request.state !== "completed" || request.noticeState !== "failed") throw new Error("No failed completion notice to retry");
      await db.transaction(async tx => {
        await tx.update(accountDeletions).set({ noticeState: "pending", updatedAt: new Date() }).where(eq(accountDeletions.id, request.id));
        await enqueue(tx, SEND_ACCOUNT_DELETED_JOB, { requestId: request.id, posts: request.posts, to: parseEmail(options.get("--email")!) }, { dedupeKey: `account-deleted:${request.id}` });
      });
      console.log(JSON.stringify({ requestId: request.id, notice: "queued" }));
    }
    if (command === "status") {
      const rows = await db.select({ id: accountDeletions.id, state: accountDeletions.state, posts: accountDeletions.posts, notice: accountDeletions.noticeState, error: accountDeletions.lastError, completedAt: accountDeletions.completedAt })
        .from(accountDeletions).where(args[0] ? eq(accountDeletions.id, args[0]) : undefined);
      console.log(JSON.stringify(rows));
    }
  } finally { await closeDb(db); }
}
process.exitCode = await runCli(main);
