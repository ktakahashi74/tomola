import { runEmbeddingBackfill } from "../scripts/backfill-embeddings";
import { runTranslationRequeue } from "../scripts/requeue-translations";
import { createTestDb } from "./helpers/db";
import { captureCli } from "./helpers/cli";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ALLOW_FAKE_FLAG, fakeEngineRefusal } from "~/lib/script-guards";

// Operational-script safeguards against fake engines (app/lib/script-guards.ts).
describe("fakeEngineRefusal", () => {
  it("refuses a fake engine unless --allow-fake is given, and says what to do", () => {
    const message = fakeEngineRefusal({ script: "translations:requeue", engine: "primary translation", engineId: "fake", args: [] })!;
    expect(message).toContain("translations:requeue refused");
    expect(message).toContain(ALLOW_FAKE_FLAG);
    expect(message).not.toContain("--prune-other-models");
    expect(fakeEngineRefusal({ script: "translations:requeue", engine: "primary translation", engineId: "fake", args: ["--divergence", ALLOW_FAKE_FLAG] })).toBeNull();
  });

  it("names the deletion the backfill would do with --prune-other-models", () => {
    expect(fakeEngineRefusal({ script: "embeddings:backfill", engine: "embedding", engineId: "fake", args: ["--prune-other-models"] })).toContain("delete every real embedding");
  });

  it("does nothing for a real engine", () => {
    for (const engineId of ["gemini", "claude"]) expect(fakeEngineRefusal({ script: "embeddings:backfill", engine: "embedding", engineId, args: [] })).toBeNull();
  });
});

// Exercise command functions against disposable test databases, without API keys.
describe("the operator scripts in an environment without API keys", () => {
  const openDb = vi.fn(createTestDb);
  const run = (script: string, ...args: string[]) => captureCli(output =>
    (script === "backfill-embeddings.ts" ? runEmbeddingBackfill : runTranslationRequeue)(args, openDb, output));

  it("embeddings:backfill refuses (also with --prune-other-models) before it opens the database, and runs with --allow-fake", { timeout: 180_000 }, async () => {
    for (const args of [[], ["--prune-other-models"]]) {
      const refused = (await run("backfill-embeddings.ts", ...args));
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.stderr).toContain("embeddings:backfill refused");
      expect(refused.stderr).toContain(ALLOW_FAKE_FLAG);
      expect(refused.stdout).toBe("");
    }
    // Reject before opening the database; the PGlite directory does not exist yet.
    expect(openDb).not.toHaveBeenCalled();
    const ok = (await run("backfill-embeddings.ts", "--prune-other-models", ALLOW_FAKE_FLAG));
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("model: fake/");
    expect(ok.stdout).toContain("deleted 0 embedding(s) of other models");
  });

  it("translations:requeue refuses, and runs with --allow-fake", { timeout: 180_000 }, async () => {
    const refused = (await run("requeue-translations.ts"));
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain("translations:requeue refused");
    expect(refused.stdout).toBe("");
    const ok = (await run("requeue-translations.ts", ALLOW_FAKE_FLAG));
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("queued 0 translate_entry job(s)");
  });

  it("still rejects unknown options and mentions the new flag in the usage", { timeout: 120_000 }, async () => {
    for (const script of ["backfill-embeddings.ts", "requeue-translations.ts"]) {
      const res = (await run(script, "--nope"));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("unknown option: --nope");
      expect(res.stderr).toContain(ALLOW_FAKE_FLAG);
    }
  });
});

it("operator CLIs reject bad options and fake engines with exit 1 before opening a database", { timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guards-cli-"));
  try {
    const env = { PATH: process.env.PATH, NODE_ENV: "test", PGLITE_DATA_DIR: path.join(dir, "db") };
    for (const script of ["backfill-embeddings.ts", "requeue-translations.ts"]) {
      for (const args of [["--nope"], []]) {
        const result = spawnSync(path.resolve("node_modules/.bin/tsx"), [`scripts/${script}`, ...args], { env, encoding: "utf8", timeout: 30_000 });
        expect(result.status).toBe(1); expect(result.stderr).toContain(ALLOW_FAKE_FLAG); expect(result.stdout).toBe("");
      }
    }
    expect(fs.existsSync(env.PGLITE_DATA_DIR)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
