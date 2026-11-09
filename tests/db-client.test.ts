import { acquireLock } from "~/lib/db/pglite.server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "~/lib/auth/auth.server";
import {
  closeDb,
  DEFAULT_PGLITE_DATA_DIR,
  getDb,
  migrationsFolder,
  openDb,
  openPgliteDb,
  resolveDbConfig,
} from "~/lib/db/client.server";
import { createTestDb } from "./helpers/db";

let dir: string;
let dataDir: string;
let lockPath: string;
const releases: Array<() => void> = [];

function hold(target: string): () => void {
  const release = acquireLock(target);
  releases.push(release);
  return release;
}

// Find a nonexistent PID; Linux PID limits are around 2^22.
function deadPid(): number {
  for (let pid = 4_000_000; pid > 3_000_000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no dead pid found");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-lock-"));
  dataDir = path.join(dir, "data", "pglite");
  lockPath = `${dataDir}.lock`;
});

afterEach(() => {
  while (releases.length) releases.pop()!();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("creates <dataDir>.lock containing the pid, and removes it on release", () => {
    const release = hold(dataDir);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("refuses a second acquisition while the holder is alive", () => {
    hold(dataDir);
    expect(() => acquireLock(dataDir)).toThrow(`PGlite data directory is in use by process ${process.pid}: ${dataDir}`);
    // A rejected attempt leaves the earlier lock intact.
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  it("can be acquired again after release", () => {
    hold(dataDir)();
    expect(() => hold(dataDir)).not.toThrow();
  });

  it("replaces a stale lock whose process is dead", () => {
    const pid = deadPid();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(pid));
    hold(dataDir);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  it("replaces a lock whose content is not a pid", () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "");
    hold(dataDir);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  it("does not remove a lock that another process has taken over", () => {
    const release = hold(dataDir);
    fs.writeFileSync(lockPath, String(process.ppid));
    release();
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.ppid));
  });
});

// Disk-backed DBs initialize PostgreSQL from scratch rather than cloning an in-memory DB, taking several seconds under parallel load.
describe("openPgliteDb and getDb", { timeout: 30_000 }, () => {
  it("locks a data directory but not an in-memory database", async () => {
    await closeDb(await openPgliteDb(undefined, { migrate: false }));
    await closeDb(await openPgliteDb(undefined, { migrate: false }));
    const db = await openPgliteDb(dataDir, { migrate: false });
    releases.push(() => fs.rmSync(lockPath, { force: true }));
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    await expect(openPgliteDb(dataDir)).rejects.toThrow(/in use by process/);
    await closeDb(db);
  });

  it("does not cache a failed open in getDb", async () => {
    const g = globalThis as { __tomolaDb?: Promise<unknown> };
    const previous = { cached: g.__tomolaDb, url: process.env.DATABASE_URL, dir: process.env.PGLITE_DATA_DIR };
    g.__tomolaDb = undefined;
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dataDir;
    try {
      const release = hold(dataDir);
      await expect(getDb()).rejects.toThrow(/in use by process/);
      expect(g.__tomolaDb).toBeUndefined();
      release();
      const db = await getDb();
      expect(g.__tomolaDb).toBeDefined();
      await closeDb(db);
    } finally {
      g.__tomolaDb = previous.cached;
      if (previous.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous.url;
      if (previous.dir === undefined) delete process.env.PGLITE_DATA_DIR;
      else process.env.PGLITE_DATA_DIR = previous.dir;
    }
  });

  it("releases the lock when the database is closed", async () => {
    const db = await openPgliteDb(dataDir);
    expect(fs.existsSync(lockPath)).toBe(true);
    await closeDb(db);
    expect(fs.existsSync(lockPath)).toBe(false);
    // Reopening is possible after closing.
    await closeDb(await openDb({ kind: "pglite", dataDir }));
  });

  it("applies migrations on open unless told not to", async () => {
    const migrated = await openPgliteDb();
    await expect(migrated.execute("select 1 from invitations limit 1")).resolves.toBeDefined();
    const bare = await openPgliteDb(undefined, { migrate: false });
    await expect(bare.execute("select 1 from invitations limit 1")).rejects.toThrow();
  });
});

describe("resolveDbConfig", () => {
  it("uses node-postgres for postgres:// and postgresql:// URLs", () => {
    expect(resolveDbConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/tomola" })).toEqual({
      kind: "pg",
      url: "postgres://u:p@localhost:5432/tomola",
    });
    expect(resolveDbConfig({ DATABASE_URL: "postgresql://localhost/tomola" })).toEqual({
      kind: "pg",
      url: "postgresql://localhost/tomola",
    });
  });

  it("prefers a postgres URL over PGLITE_DATA_DIR", () => {
    expect(resolveDbConfig({ DATABASE_URL: "postgres://localhost/x", PGLITE_DATA_DIR: "./d" }).kind).toBe("pg");
  });

  it("uses PGlite at PGLITE_DATA_DIR, with ./.data/pglite as the default", () => {
    expect(resolveDbConfig({ PGLITE_DATA_DIR: "/var/tomola" })).toEqual({ kind: "pglite", dataDir: "/var/tomola" });
    expect(resolveDbConfig({})).toEqual({ kind: "pglite", dataDir: DEFAULT_PGLITE_DATA_DIR });
    expect(DEFAULT_PGLITE_DATA_DIR).toBe("./.data/pglite");
    // Treat empty values as unset.
    expect(resolveDbConfig({ DATABASE_URL: "", PGLITE_DATA_DIR: " " })).toEqual({
      kind: "pglite",
      dataDir: DEFAULT_PGLITE_DATA_DIR,
    });
  });

  it("accepts a legacy DATABASE_URL path only while PGLITE_DATA_DIR is unset", () => {
    expect(resolveDbConfig({ DATABASE_URL: "./old/pglite" })).toEqual({
      kind: "pglite",
      dataDir: "./old/pglite",
      legacy: true,
    });
    expect(resolveDbConfig({ DATABASE_URL: "./old/pglite", PGLITE_DATA_DIR: "./new" })).toEqual({
      kind: "pglite",
      dataDir: "./new",
    });
  });

  it("does not mistake a path that merely contains postgres for a URL", () => {
    expect(resolveDbConfig({ DATABASE_URL: "./postgres://x" }).kind).toBe("pglite");
  });
});

describe("migrationsFolder", () => {
  it("does not depend on the current working directory", () => {
    const cwd = process.cwd();
    const expected = migrationsFolder();
    process.chdir(os.tmpdir());
    try {
      expect(migrationsFolder()).toBe(expected);
      expect(fs.existsSync(path.join(expected, "meta", "_journal.json"))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("getAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not cache a failed creation", async () => {
    const g = globalThis as { __tomolaDb?: Promise<unknown>; __tomolaAuth?: Promise<unknown> };
    const previous = { db: g.__tomolaDb, auth: g.__tomolaAuth };
    g.__tomolaDb = createTestDb();
    g.__tomolaAuth = undefined;
    try {
      // Production requires BETTER_AUTH_URL and other settings; missing values fail.
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("BETTER_AUTH_SECRET", "");
      await expect(getAuth()).rejects.toThrow(/is required unless NODE_ENV is development or test/);
      expect(g.__tomolaAuth).toBeUndefined();
      vi.stubEnv("NODE_ENV", "test");
      await expect(getAuth()).resolves.toBeDefined();
      expect(g.__tomolaAuth).toBeDefined();
    } finally {
      g.__tomolaDb = previous.db;
      g.__tomolaAuth = previous.auth;
    }
  });
});
