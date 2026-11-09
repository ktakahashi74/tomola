import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const entrypoint = path.join(process.cwd(), "docker-entrypoint.sh");

function runEntrypoint(checkStatus: number, migrateStatus: number) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "startup-shell-"));
  try {
    const bin = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    const trace = path.join(dir, "calls");
    fs.writeFileSync(path.join(bin, "tsx"), `#!/bin/sh
case "$1" in
  scripts/check-startup.ts) printf 'check\\n' >> "$TRACE_FILE"; exit "$CHECK_STATUS" ;;
  scripts/migrate.ts) printf 'migrate\\n' >> "$TRACE_FILE"; exit "$MIGRATE_STATUS" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh
test "$1" = server.ts || exit 99
printf 'server\\n' >> "$TRACE_FILE"
`, { mode: 0o755 });
    const result = spawnSync("sh", [entrypoint], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE_FILE: trace, CHECK_STATUS: String(checkStatus), MIGRATE_STATUS: String(migrateStatus) },
      encoding: "utf8",
    });
    return { status: result.status, calls: fs.readFileSync(trace, "utf8").trim().split("\n") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("Docker pre-migration startup gate", () => {
  it("stops before migrations and server startup when configuration or language counts are rejected", () => {
    expect(runEntrypoint(23, 0)).toEqual({ status: 23, calls: ["check"] });
  });

  it("runs migrations only after the gate passes and never starts the server after migration failure", () => {
    expect(runEntrypoint(0, 31)).toEqual({ status: 31, calls: ["check", "migrate"] });
  });

  it("executes the server after both the gate and migrations pass", () => {
    expect(runEntrypoint(0, 0)).toEqual({ status: 0, calls: ["check", "migrate", "server"] });
  });
});
