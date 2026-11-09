import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("checks villages after migration only when enabled and stops the server on failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "village-startup-"));
  try {
    const bin = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "tsx"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$TRACE_FILE"\ncase "$1" in scripts/check-villages.ts) exit "$VILLAGE_STATUS" ;; esac\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "node"), '#!/bin/sh\nprintf "server\\n" >> "$TRACE_FILE"\n', { mode: 0o755 });
    for (const [flag, status, expected] of [
      ["", "0", ["scripts/check-startup.ts", "scripts/migrate.ts", "server"]],
      [" 1 ", "0", ["scripts/check-startup.ts", "scripts/migrate.ts", "scripts/check-villages.ts", "server"]],
      ["1", "27", ["scripts/check-startup.ts", "scripts/migrate.ts", "scripts/check-villages.ts"]],
    ] as const) {
      const trace = path.join(dir, "trace");
      fs.rmSync(trace, { force: true });
      const result = spawnSync("sh", [path.resolve("docker-entrypoint.sh")], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE_FILE: trace, VILLAGES: flag, VILLAGE_STATUS: status } });
      expect(result.status).toBe(Number(status));
      expect(fs.readFileSync(trace, "utf8").trim().split("\n")).toEqual(expected);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
