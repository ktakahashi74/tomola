import { getOperatorDb } from "../app/lib/db/client.server";
import { translationReadStats } from "../app/lib/translation-on-read.server";
import { isMain, runCli } from "./cli";

// Read-only operator CLI; no member identities or read counts are selected.
export async function runTranslationReadStats() {
  const db = await getOperatorDb();
  console.log(JSON.stringify(await translationReadStats(db), null, 2));
  return 0;
}
if (isMain(import.meta.url)) process.exit(await runCli(runTranslationReadStats));
