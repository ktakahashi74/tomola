import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { closeDb, openPgliteDb } from "~/lib/db/client.server";
import { accountDeletions, jobs, user, villageMembers, villages } from "~/lib/db/schema";
import { createProfile } from "~/lib/profiles.server";

it("runs the operator command, inspects and retries completion, cancels pending work and requeues a failed notice", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "account-delete-cli-"));
  const data = path.join(dir, "pglite");
  const run = (...args: string[]) => spawnSync(path.resolve("node_modules/.bin/tsx"), ["scripts/delete-account.ts", ...args], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "test", PGLITE_DATA_DIR: data, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", SMTP_URL: "" }, encoding: "utf8", timeout: 30_000,
  });
  try {
    const db = await openPgliteDb(data);
    try {
      await db.insert(user).values({ id: "quit-cli", email: "quit-cli@example.com", name: "" });
      await createProfile(db, "quit-cli", { handle: "quit_cli", homeArea: "ja", readLangs: ["ja"] });
      await db.insert(accountDeletions).values({ id: "cancel-me", userId: null });
    } finally { await closeDb(db); }
    expect(run("run", "quit-cli").status).toBe(1);
    expect(run("run", "quit-cli", "--confirm-handle", "wrong").status).toBe(1);
    const result = run("run", "quit-cli", "--confirm-handle", "quit_cli");
    expect(result.stderr).toBe(""); expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("quit-cli"); expect(result.stdout).not.toContain("quit_cli");
    const { requestId } = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(JSON.parse(run("status", requestId).stdout)).toMatchObject([{ id: requestId, state: "completed", posts: "keep", notice: "pending" }]);
    expect(run("retry", requestId).status).toBe(0);
    expect(run("cancel", "cancel-me").status).toBe(0);
    expect(run("retry-mail", requestId, "--email", "quit-cli@example.com").status).toBe(1);
    const reopened = await openPgliteDb(data, { migrate: false });
    try {
      expect(await reopened.select().from(user).where(eq(user.id, "quit-cli"))).toEqual([]);
      expect(await reopened.select().from(accountDeletions).where(eq(accountDeletions.state, "completed"))).toHaveLength(1);
      expect((await reopened.select().from(accountDeletions).where(eq(accountDeletions.id, "cancel-me")))[0].state).toBe("cancelled");
      await reopened.update(jobs).set({ status: "failed", payload: { requestId } });
      await reopened.update(accountDeletions).set({ noticeState: "failed" }).where(eq(accountDeletions.id, requestId));
    } finally { await closeDb(reopened); }
    const retry = run("retry-mail", requestId, "--email", "quit-cli@example.com");
    expect(retry.status).toBe(0); expect(retry.stdout).not.toContain("quit-cli@example.com");
    expect(JSON.parse(retry.stdout)).toEqual({ requestId, notice: "queued" });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}, 90_000);

it("lists every unchosen shared village without mutations and applies explicit per-village choices on rerun", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "account-villages-cli-"));
  const data = path.join(dir, "pglite");
  const run = (...args: string[]) => spawnSync(path.resolve("node_modules/.bin/tsx"), ["scripts/delete-account.ts", "run", "operator-quit", "--confirm-handle", "operator_quit", ...args], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "test", PGLITE_DATA_DIR: data, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", SMTP_URL: "" }, encoding: "utf8", timeout: 30_000,
  });
  try {
    const db = await openPgliteDb(data);
    try {
      for (const id of ["operator-quit", "operator-next"]) {
        await db.insert(user).values({ id, email: `${id}@example.com`, name: "" });
        await createProfile(db, id, { handle: id.replaceAll("-", "_"), homeArea: "en" });
      }
      for (const slug of ["operator-end", "operator-transfer"]) {
        const [village] = await db.insert(villages).values({ slug, name: slug, kind: "invite_public" }).returning();
        await db.insert(villageMembers).values([{ villageId: village.id, userId: "operator-quit", role: "owner" }, { villageId: village.id, userId: "operator-next" }]);
      }
    } finally { await closeDb(db); }
    for (const choices of [[], ["--village", "operator-end=end"], ["--village", "operator-transfer=member:unknown"], ["--village", "unknown=end"], ["--village", "operator-end=end", "--village", "operator-end=end"]]) {
      const result = run(...choices);
      expect(result.status).toBe(1);
      if (!choices.length) expect(JSON.parse(result.stderr)).toMatchObject({ error: "village_required", villages: [
        { name: "operator-end", slug: "operator-end", members: 2 }, { name: "operator-transfer", slug: "operator-transfer", members: 2 },
      ] });
      const check = await openPgliteDb(data, { migrate: false });
      try {
        expect(await check.select().from(user).where(eq(user.id, "operator-quit"))).toHaveLength(1);
        expect(await check.select().from(accountDeletions)).toEqual([]);
        expect((await check.select().from(villages).where(eq(villages.kind, "invite_public"))).every(row => row.endedAt === null)).toBe(true);
      } finally { await closeDb(check); }
    }
    const chosen = run("--village", "operator-end=end", "--village", "operator-transfer=member:@OPERATOR_NEXT");
    expect(chosen.status).toBe(0);
    const check = await openPgliteDb(data, { migrate: false });
    try {
      const rows = await check.select().from(villages).where(eq(villages.kind, "invite_public"));
      expect(rows.find(row => row.slug === "operator-end")!.endedAt).not.toBeNull();
      const transferred = rows.find(row => row.slug === "operator-transfer")!;
      expect(transferred.endedAt).toBeNull();
      expect(await check.select().from(villageMembers).where(eq(villageMembers.villageId, transferred.id))).toMatchObject([{ userId: "operator-next", role: "owner" }]);
    } finally { await closeDb(check); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}, 120_000);
