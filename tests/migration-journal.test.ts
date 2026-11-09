import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsFolder } from "~/lib/db/client.server";

// Drizzle applies a journal entry only when its `when` is later than the `when` of the last migration already applied to the database.
// A migration whose `when` is not later than a migration that is already applied is silently skipped on a database migrated before it.
// So when a branch is merged and its migration is renumbered by hand, the entry keeps its old `when` and may be skipped; the migration has to be regenerated
// (drizzle-kit generate gives it a fresh `when`). This test makes a stale `when` fail instead of being skipped quietly.

type Entry = { idx: number; when: number; tag: string };
const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as { entries: Entry[] };

describe("drizzle/meta/_journal.json", () => {
  it("has a strictly increasing `when` (an entry with an earlier `when` than its predecessor would be skipped on a database that already has the predecessor)", () => {
    const offenders = journal.entries.flatMap((entry, i) => (i > 0 && entry.when <= journal.entries[i - 1].when ? [`${journal.entries[i - 1].tag} (${journal.entries[i - 1].when}) -> ${entry.tag} (${entry.when})`] : []));
    expect(offenders).toEqual([]);
  });

  it("has idx equal to the position, tags that start with the same number, and an SQL file and a snapshot for every entry", () => {
    journal.entries.forEach((entry, i) => {
      expect(entry.idx, entry.tag).toBe(i);
      expect(entry.tag.slice(0, 4), entry.tag).toBe(String(i).padStart(4, "0"));
      expect(fs.existsSync(path.join(migrationsFolder(), `${entry.tag}.sql`)), `${entry.tag}.sql`).toBe(true);
      expect(fs.existsSync(path.join(migrationsFolder(), "meta", `${String(i).padStart(4, "0")}_snapshot.json`)), `${entry.tag} snapshot`).toBe(true);
    });
  });
});
