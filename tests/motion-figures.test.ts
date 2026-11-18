import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { MOTION_LIMITS, MEDIA_LIMITS, parseMediaPath } from "~/lib/media";
import { inspectMotion } from "~/lib/motion-header";
import { processUploadedMedia, rewriteMedia, withMediaSlot, withMotionSlot } from "~/lib/media-processing.server";
import { deleteMedia, deleteMediaWithLog, listOwnMedia, pairedMedia, putMedia, putUploadedMedia, readMedia } from "~/lib/media-store.server";
import { deleteAccount } from "~/lib/account-delete.server";
import { canReadMedia, referencedMediaIds } from "~/lib/media-references.server";
import { decorateMotionHtml, motionImages } from "~/lib/motion-display.server";
import { prepareEntryFigureDisplay } from "~/lib/figure-display.server";
import { publicFigureCondition } from "~/lib/figure-translation.server";
import { createTopic, editEntry } from "~/lib/entries.server";
import { entries, media, motionDelivery } from "~/lib/db/schema";
import { exportSite } from "~/lib/site-export.server";
import { countMotionDelivery } from "~/lib/motion-delivery.server";
import { renderMarkdown } from "~/lib/markdown.server";
import { addMember, closeTestDb, createTestDb } from "./helpers/db";
import { motionImage } from "./helpers/motion-images";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { db = await createTestDb(); await addMember(db, "motion-author", "motion_author"); await addMember(db, "motion-other", "motion_other"); });
afterAll(async () => { await closeTestDb(db); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each(["gif", "webp"] as const)("rewrites %s with timing, looping, transparency and an informative still", async format => {
  const input = await motionImage(format);
  const output = await processUploadedMedia(input.bytes);
  const meta = await sharp(output.bytes, { animated: true }).metadata();
  expect(meta).toMatchObject({ format: "webp", pages: input.frames, pageHeight: input.height, width: input.width, delay: input.delay, loop: 3, hasAlpha: true });
  expect(meta.exif).toBeUndefined(); expect(meta.xmp).toBeUndefined(); expect(meta.icc).toBeUndefined();
  expect(output.poster).toBeDefined();
  const poster = await sharp(output.poster!.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(poster.data[3]).toBe(0);
  const dark = Array.from({ length: poster.info.width * poster.info.height }, (_, i) => i * 4).filter(i => poster.data[i + 3] > 200 && poster.data[i] < 150).length;
  expect(dark).toBeGreaterThan(50);
  const comment = Buffer.from("Synthetic comment");
  if (format === "gif") {
    const annotated = Buffer.concat([input.bytes.subarray(0, -1), Buffer.from([0x21, 0xfe, comment.length]), comment, Buffer.from([0, 0x3b])]);
    expect((await rewriteMedia(annotated)).bytes.includes(comment)).toBe(false);
  }
});

it("stores a single-frame GIF as an ordinary still", async () => {
  const result = await rewriteMedia((await motionImage("gif", 1)).bytes);
  expect(result.frames).toBe(1); expect(result.poster).toBeUndefined();
  const saved = await putUploadedMedia(db, "motion-author", result);
  expect((await readMedia(db, parseMediaPath(saved.url)!.id))?.animated).toBe(false);
});

it("rejects malformed containers, disguised videos and APNG", async () => {
  const gif = (await motionImage()).bytes;
  for (const input of [gif.subarray(0, -2), Buffer.from("GIF89a"), Buffer.from("\0\0\0\x18ftypmp42"), Buffer.from("not a GIF")]) await expect(rewriteMedia(input)).rejects.toBeDefined();
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
  const chunk = Buffer.alloc(20); chunk.writeUInt32BE(8); chunk.write("acTL", 4);
  await expect(rewriteMedia(Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]))).rejects.toMatchObject({ code: "type" });
});

it("rejects each container limit before any pixel decoder runs", async () => {
  const fixture = await motionImage("webp", 4);
  const chunk = fixture.bytes.indexOf("VP8X");
  for (const dimension of [4, 7]) {
    const huge = Buffer.from(fixture.bytes); huge.writeUIntLE(MOTION_LIMITS.width, chunk + 8 + dimension, 3);
    expect(() => inspectMotion(huge)).toThrow("media too_large");
  }
  const frame = fixture.bytes.indexOf("ANMF");
  const long = Buffer.from(fixture.bytes); long.writeUIntLE(MOTION_LIMITS.durationMs + 1, frame + 8 + 12, 3);
  expect(() => inspectMotion(long)).toThrow("media too_large");
  const pieces: Buffer[] = [];
  let prefix = fixture.bytes.subarray(0, frame);
  const size = fixture.bytes.readUInt32LE(frame + 4), block = fixture.bytes.subarray(frame, frame + 8 + size + size % 2);
  for (let i = 0; i <= MOTION_LIMITS.frames; i++) pieces.push(block);
  const many = Buffer.concat([prefix, ...pieces]); many.writeUInt32LE(many.length - 8, 4);
  expect(() => inspectMotion(many)).toThrow("media too_large");
  const pixels = Buffer.from(many); pixels.writeUIntLE(1999, chunk + 12, 3); pixels.writeUIntLE(1999, chunk + 15, 3);
  expect(() => inspectMotion(pixels)).toThrow("media too_large");
  await expect(rewriteMedia(Buffer.alloc(MEDIA_LIMITS.inputBytes + 1))).rejects.toMatchObject({ code: "too_large" });
});

it("serializes motion work, bounds waiting and leaves static slots available", async () => {
  const release: Array<() => void> = [], started: number[] = [];
  const work = (i: number) => withMotionSlot(async () => { started.push(i); await new Promise<void>(resolve => release.push(resolve)); });
  const first = work(0), second = work(1), third = work(2);
  await expect(work(3)).rejects.toMatchObject({ status: 503 });
  await expect(withMediaSlot(async () => "still")).resolves.toBe("still");
  expect(started).toEqual([0]); release.shift()!(); await first;
  expect(started).toEqual([0, 1]); release.shift()!(); await second;
  expect(started).toEqual([0, 1, 2]); release.shift()!(); await third;
});

it("enforces stored motion bytes independently of input bytes", async () => {
  const bytes = await sharp(randomBytes(800 * 800 * 3 * 5), { raw: { width: 800, height: 4000, channels: 3, pageHeight: 800 } }).webp({ lossless: true, delay: [100, 100, 100, 100, 100], loop: 0 }).toBuffer();
  expect(bytes.length).toBeLessThan(MEDIA_LIMITS.inputBytes);
  await expect(rewriteMedia(bytes)).rejects.toMatchObject({ code: "too_large" });
}, 60_000);

it("fits the longest edge without enlarging and keeps all frames", async () => {
  const input = await motionImage("gif", 3, 2400, 200);
  const output = await rewriteMedia(input.bytes);
  const meta = await sharp(output.bytes, { animated: true }).metadata();
  expect(meta.width).toBe(2000); expect(meta.pageHeight).toBeLessThanOrEqual(200); expect(meta.pages).toBe(3);
  expect(meta.delay).toEqual(input.delay);
});

it("binds explicit authored pairs, visibility, translation exclusion, export and deletion", async () => {
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:5585");
  const saved = await putUploadedMedia(db, "motion-author", await rewriteMedia((await motionImage()).bytes));
  if (!("posterUrl" in saved)) throw new Error("poster missing");
  const body = `[![diagram](${saved.posterUrl})](${saved.url})`;
  const ids = referencedMediaIds(body); expect(ids).toHaveLength(2);
  const motionId = parseMediaPath(saved.url)!.id;
  expect(await canReadMedia(db, motionId, null)).toBe(false);
  const created = await createTopic(db, "motion-author", { title: "Motion fixture", body, lang: "en" });
  if (!created.ok) throw new Error(created.error);
  expect(await canReadMedia(db, motionId, null)).toBe(true);
  const html = await renderMarkdown(body);
  const images = await motionImages(db, [html]);
  const repeated = await renderMarkdown(Array(16).fill(body).join("\n\n"));
  expect(decorateMotionHtml(repeated, repeated, "motion-author", images).match(/data-motion-figure/g)).toHaveLength(15);
  expect(decorateMotionHtml(html, html, "motion-author", images)).toContain("data-motion-figure");
  expect(decorateMotionHtml(html, html, "motion-other", images)).not.toContain("data-motion-figure");
  expect((await prepareEntryFigureDisplay(db, [created.id], "en"))(created.id, html)).toContain("data-motion-figure");
  const plain = await renderMarkdown(`![diagram](${saved.url})`);
  expect(decorateMotionHtml(plain, plain, "motion-author", images)).not.toContain("<img");
  for (const other of [`[![diagram](${saved.posterUrl})](https://example.com/a.webp)`, `[![diagram](${saved.posterUrl})](${saved.posterUrl})`]) {
    const h = await renderMarkdown(other); expect(decorateMotionHtml(h, h, "motion-author", images)).not.toContain("data-motion-figure");
  }
  expect((await db.select({ id: media.id }).from(media).where(publicFigureCondition(db))).map(image => image.id)).not.toContain(motionId);
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, created.id));
  expect(await canReadMedia(db, motionId, null)).toBe(false);
  await db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, created.id));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-export-"));
  try {
    await exportSite(db, { outDir: path.join(dir, "site"), langs: ["en"] });
    expect((await fs.readdir(path.join(dir, "site/assets/media"))).some(file => file.startsWith(motionId))).toBe(true);
    expect(await fs.readFile(path.join(dir, `site/en/t/${created.id}.md`), "utf8")).toMatch(/\[!\[diagram\]\([^)]*\.webp>\)\]\([^)]*\.webp>\)/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  const replacement = await putMedia(db, "motion-author", await rewriteMedia(await sharp({ create: { width: 160, height: 100, channels: 3, background: "blue" } }).png().toBuffer()));
  expect(await editEntry(db, "motion-author", created.id, { body: `[![replacement](${replacement.url})](${saved.url})` }, { kind: "topic" })).toMatchObject({ ok: true });
  expect(await pairedMedia(db, motionId)).toHaveLength(3);
  const actor = { id: "motion-other", scope: { operator: true, langs: [] } };
  expect(await deleteMediaWithLog(db, actor, { id: motionId, reason: "other", note: "Synthetic deletion", confirmedIds: "" })).toMatchObject({ ok: false, error: "confirm_required" });
  expect(await deleteMedia(db, parseMediaPath(replacement.url)!.id)).toBe(true);
  for (const id of [...ids, parseMediaPath(replacement.url)!.id]) expect(await readMedia(db, id)).toBeNull();
});

it("stores both assets atomically under the existing image-count quota", async () => {
  await addMember(db, "motion-quota", "motion_quota");
  await db.insert(media).values(Array.from({ length: MEDIA_LIMITS.storedCount - 1 }, (_, i) => ({ id: i.toString(16).padStart(64, "0"), uploadedBy: "motion-quota", bytes: Buffer.from([1]), mime: "image/webp", width: 1, height: 1, byteSize: 1 })));
  await expect(putUploadedMedia(db, "motion-quota", await rewriteMedia((await motionImage()).bytes))).rejects.toMatchObject({ code: "quota" });
  expect(await db.select().from(media).where(eq(media.uploadedBy, "motion-quota"))).toHaveLength(MEDIA_LIMITS.storedCount - 1);
});

it("lists unused motion pairs and clears both during account cleanup", async () => {
  await addMember(db, "motion-cleanup", "motion_cleanup");
  await putUploadedMedia(db, "motion-cleanup", await rewriteMedia((await motionImage()).bytes));
  const images = await listOwnMedia(db, "motion-cleanup");
  expect(images).toHaveLength(2); expect(images.every(image => image.related.length === 2)).toBe(true);
  await deleteAccount(db, "motion-cleanup", { confirmation: "motion_cleanup", posts: "delete" });
  for (const image of images) expect(await readMedia(db, image.id)).toBeNull();
});

it("records only daily aggregate delivery bytes and counts", async () => {
  const now = new Date("2026-01-02T03:00:00Z");
  await countMotionDelivery(db, 123, now); await countMotionDelivery(db, 456, now);
  expect(await db.select().from(motionDelivery)).toContainEqual({ day: "2026-01-02", requests: 2, bytes: 579 });
});
