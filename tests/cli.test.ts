import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("isMain", () => {
  const root = process.cwd();
  let directory: string;
  beforeAll(() => {
    fs.mkdirSync(path.join(root, ".data/tests-unit"), { recursive: true });
    directory = fs.mkdtempSync(path.join(root, ".data/tests-unit/cli-"));
    fs.symlinkSync(root, path.join(directory, "source"), "dir");
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  const run = (script: string) => spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", script, "--nope"], {
    cwd: root, env: { ...process.env, NODE_ENV: "test" }, encoding: "utf8", timeout: 30_000,
  });

  it.each(["relative path", "symlink absolute path", "extensionless path"])("executes the CLI through a %s", { timeout: 60_000 }, kind => {
    const script = kind === "symlink absolute path"
      ? path.join(directory, "source/scripts/requeue-translations.ts")
      : `scripts/requeue-translations${kind === "extensionless path" ? "" : ".ts"}`;
    const result = run(script);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown option: --nope");
    expect(result.stderr).toContain("usage:");
  });

  it("does not execute a script that is only imported", () => {
    const probe = path.join(directory, "import-probe.mts");
    const url = pathToFileURL(path.join(root, "scripts/requeue-translations.ts")).href;
    fs.writeFileSync(probe, `await import(${JSON.stringify(url)});\nconsole.log("import complete");\n`);
    const result = run(probe);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("import complete\n");
    expect(result.stderr).toBe("");
  });
});
