import { runCli } from "./cli";
import { closeDb, getOperatorDb as getDb } from "../app/lib/db/client.server";
import { runPrepareVillages } from "../app/lib/villages-prepare.server";

async function main() {
  let opened: Awaited<ReturnType<typeof getDb>> | undefined;
  try {
    process.exitCode = await runPrepareVillages(process.argv.slice(2), { getDb: async () => (opened = await getDb()) });
  } finally {
    if (opened) await closeDb(opened);
  }
}

process.exitCode = await runCli(main);
