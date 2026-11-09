import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrationsFolder } from "../../app/lib/db/client.server";

// Migrations are called by their name (the part after the number), never by a number: the number is given when a branch is merged.
type Journal = { entries: Array<{ tag: string }> };
const journal = (): Journal => JSON.parse(fs.readFileSync(path.join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as Journal;

// The tag of the migration with this name, e.g. "0045_follows_notifications" for "follows_notifications". Throws if there is not exactly one.
export function migrationTag(name: string): string {
  const found = journal().entries.filter((e) => e.tag.replace(/^\d+_/, "") === name);
  if (found.length !== 1) throw new Error(`expected exactly one migration named ${name}, found ${found.length}`);
  return found[0].tag;
}

// The SQL file of the migration with this name.
export function migrationFile(name: string): string {
  return path.join(migrationsFolder(), `${migrationTag(name)}.sql`);
}

// A temporary migrations folder with everything that comes before the named migration, in journal order (a database "one migration earlier"). The caller removes it.
export function migrationsBefore(name: string): string {
  const tag = migrationTag(name);
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `mig-before-${name}-`));
  fs.mkdirSync(path.join(dir, "meta"));
  const all = journal();
  const kept = all.entries.slice(0, all.entries.findIndex((e) => e.tag === tag));
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ ...all, entries: kept }));
  for (const e of kept) fs.copyFileSync(path.join(migrationsFolder(), `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

// The statements of a migration file, ready to run one by one (drizzle's breakpoints; comment-only parts are dropped).
export function migrationStatements(name: string): string[] {
  return fs
    .readFileSync(migrationFile(name), "utf8")
    .split("--> statement-breakpoint")
    .filter((statement) => statement.replace(/^--.*$/gm, "").trim());
}
