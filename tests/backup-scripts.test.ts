import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-backup-")); roots.push(root);
  const log = path.join(root, "commands.jsonl"), dumps = path.join(root, "backups");
  fs.mkdirSync(dumps);
  fs.writeFileSync(path.join(root, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), text = args.join(' ');
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args)+'\\n');
if (text.includes('pg_dump')) process.stdout.write('valid dump');
if (text.includes('pg_restore --list') && process.env.FAIL_LIST) process.exit(6);
if (text.includes('--exit-on-error') && process.env.FAIL_RESTORE) process.exit(7);
`, { mode: 0o755 });
  const run = (script: string, args: string[], extra = {}) => spawnSync("bash", [path.resolve("scripts", script), ...args], { cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, MOCK_LOG: log, ...extra }, encoding: "utf8" });
  const commands = () => fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  return { root, dumps, run, commands };
}
it("verifies a uniquely named dump before pruning completed backups", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.dumps, "tomola-20000101T000000000000000Z-123.dump"), "old");
  fs.writeFileSync(path.join(f.dumps, "tomola-manual.dump"), "manual");
  fs.writeFileSync(path.join(f.dumps, "tomola-20000101T000000Z.dump"), "other format");
  fs.writeFileSync(path.join(f.dumps, "unrelated.dump"), "keep");
  const result = f.run("backup-db.sh", [f.dumps, "1"]);
  expect(result.status).toBe(0);
  const file = result.stdout.trim();
  expect(fs.readFileSync(file, "utf8")).toBe("valid dump");
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(f.dumps).sort()).toEqual([path.basename(file), "unrelated.dump", "tomola-manual.dump", "tomola-20000101T000000Z.dump"].sort());
  expect(f.commands().map(c => c.join(" "))).toEqual([expect.stringContaining("pg_dump"), expect.stringContaining("pg_restore --list")]);
});
it("always retains the new dump even when an existing dated dump sorts ahead of it", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.dumps, "tomola-99990101T000000000000000Z-123.dump"), "future");
  const result = f.run("backup-db.sh", [f.dumps, "1"]);
  expect(result.status).toBe(0);
  expect(fs.readFileSync(result.stdout.trim(), "utf8")).toBe("valid dump");
  expect(fs.readdirSync(f.dumps)).toEqual([path.basename(result.stdout.trim())]);
});
it("keeps older backups and removes partial output if verification fails", () => {
  const f = fixture(); fs.writeFileSync(path.join(f.dumps, "tomola-old.dump"), "old");
  expect(f.run("backup-db.sh", [f.dumps, "1"], { FAIL_LIST: "1" }).status).toBe(6);
  expect(fs.readdirSync(f.dumps)).toEqual(["tomola-old.dump"]);
  expect(f.run("backup-db.sh", [f.dumps, "0"]).status).toBe(2);
});
it.each([false, true])("restores only a disposable target and always cleans it up (failure=%s)", failed => {
  const f = fixture(), dump = path.join(f.dumps, "archive.dump"); fs.writeFileSync(dump, "dump");
  const result = f.run("restore-check.sh", [dump], failed ? { FAIL_RESTORE: "1" } : {});
  expect(result.status).toBe(failed ? 7 : 0);
  const calls = f.commands(), create = calls.find(c => c.join(" ").includes("createdb"))!;
  const target = create.at(-1)!; expect(target).toMatch(/^tomola_restore_check_[0-9_]+$/);
  expect(calls.at(-1)!.join(" ")).toContain("dropdb"); expect(calls.at(-1)!.at(-1)).toBe(target);
  expect(calls.some(c => c.includes(`RESTORE_CHECK_DB=${target}`))).toBe(!failed);
});
