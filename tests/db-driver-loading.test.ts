import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { expect, it } from "vitest";

it("opens and closes the PostgreSQL driver without loading PGlite support", () => {
  const client = pathToFileURL(path.resolve("app/lib/db/client.server.ts")).href;
  const result = spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (/pglite|pgvector/.test(specifier)) throw new Error("Unexpected embedded driver import: " + specifier);
      return next(specifier, context);
    } });
    const { openPgDb, closeDb } = await import(${JSON.stringify(client)});
    // Pool construction is lazy; no connection to a database is needed here.
    const db = await openPgDb("postgres://localhost:1/unused");
    await closeDb(db);
  `], { encoding: "utf8", timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
