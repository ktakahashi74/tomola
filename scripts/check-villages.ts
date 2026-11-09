import { runCli } from "./cli";
import { safeErrorText } from "../app/lib/error-text.server.ts";
import { closeDb, getOperatorDb as getDb } from "../app/lib/db/client.server";
import { villagesEnabled } from "../app/lib/villages-enabled.server";
import { assertVillagesReady } from "../app/lib/villages.server";

async function main() {
  if (villagesEnabled()) {
    const db = await getDb();
    try {
      await assertVillagesReady(db);
    } catch (error) {
      console.error(`[startup] ${safeErrorText(error)}`);
      process.exitCode = 1;
    } finally {
      await closeDb(db);
    }
  }
}

process.exitCode = await runCli(main);
