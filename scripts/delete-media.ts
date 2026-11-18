import { runCli } from "./cli";
import { closeDb, getOperatorDb as getDb } from "../app/lib/db/client.server";
import { deleteMedia, pairedMedia } from "../app/lib/media-store.server";

async function main() {
  const [id, ...extra] = process.argv.slice(2);
  if (extra.length || !/^[a-f0-9]{64}$/.test(id ?? "")) throw new Error("usage: pnpm media:delete <ID>");
  const db = await getDb();
  try {
    const paired = await pairedMedia(db, id);
    if (paired.length > 1) console.error(JSON.stringify({ paired: paired.map(image => image.id), notice: "Paired images are deleted together." }));
    console.log(JSON.stringify({ deleted: await deleteMedia(db, id), notice: "Previously loaded images may remain in browser caches." }));
  }
  finally { await closeDb(db); }
}

process.exitCode = await runCli(main);
