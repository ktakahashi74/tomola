import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { closeDb, openPgliteDb } from "~/lib/db/client.server";
import { media, user } from "~/lib/db/schema";
import { putMedia } from "~/lib/media-store.server";
it("the deletion command validates its argument and records a binary deletion", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-cli-"));
  const data = path.join(dir, "pglite");
  const run = async (id: string) => spawnSync(path.resolve("node_modules/.bin/tsx"), ["scripts/delete-media.ts", id], { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "test", PGLITE_DATA_DIR: data, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", SMTP_URL: "" }, encoding: "utf8", timeout: 30_000 });
  try {
    expect((await run("bad-id")).status).toBe(1);
    const db = await openPgliteDb(data);
    let id: string;
    try {
      await db.insert(user).values({ id: "cli-media", email: "media-cli@example.com", name: "" });
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).webp().toBuffer();
      const saved = await putMedia(db, "cli-media", { bytes, width: 2, height: 2 }); id = saved.url.split("/").at(-1)!.slice(0, 64);
    } finally { await closeDb(db); }
    const result = (await run(id!)); expect(result.stderr).toBe(""); expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ deleted: true, notice: expect.stringMatching(/browser caches/) });
    expect(result.stdout).not.toContain(id!); expect(result.stdout).not.toContain("cli-media");
    expect(JSON.parse((await run(id!)).stdout)).toMatchObject({ deleted: false, notice: expect.any(String) });
    const reopened = await openPgliteDb(data, { migrate: false });
    try { const [row] = await reopened.select().from(media).where(eq(media.id, id!)); expect(row.bytes).toBeNull(); expect(row.deletedAt).toBeInstanceOf(Date); }
    finally { await closeDb(reopened); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);
