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
import { deleteMedia, deleteMediaWithLog, deleteOwnMedia, listOwnMedia, pairedMedia, putMedia, putUploadedMedia, readMedia } from "~/lib/media-store.server";
import { setMemberAvatar } from "~/lib/member-avatar.server";
import { setVillageIcon } from "~/lib/village-icon.server";
import { topicShare } from "~/lib/share-preview.server";
import { deleteAccount } from "~/lib/account-delete.server";
import { canReadMedia, referencedMediaIds } from "~/lib/media-references.server";
import { decorateMotionHtml, motionImages } from "~/lib/motion-display.server";
import { prepareEntryFigureDisplay } from "~/lib/figure-display.server";
import { publicFigureCondition } from "~/lib/figure-translation.server";
import { createTopic, editEntry } from "~/lib/entries.server";
import { entries, media, motionDelivery, motionPairs, profiles, villageMembers, villages } from "~/lib/db/schema";
import { exportSite } from "~/lib/site-export.server";
import { countMotionDelivery } from "~/lib/motion-delivery.server";
import { renderMarkdown } from "~/lib/markdown.server";
import { addMember, closeTestDb, createTestDb } from "./helpers/db";
import { motionImage } from "./helpers/motion-images";
import { prepareMotionPlayback } from "~/lib/motion";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { db = await createTestDb(); await addMember(db, "motion-author", "motion_author"); await addMember(db, "motion-other", "motion_other"); });
afterAll(async () => { await closeTestDb(db); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each([0, 10, 20, 300])("uses browser frame timing for a GIF with %i ms delays, including stored zero duration", async delay => {
  const output = await rewriteMedia((await motionImage("gif", 4, 160, 100, delay)).bytes);
  expect(output.durationMs).toBe(delay * 4);
  const bytes = Uint8Array.from(output.bytes).buffer;
  expect(prepareMotionPlayback(bytes)).toBe((delay <= 10 ? 100 : delay) * 4);
  expect((await sharp(bytes, { animated: true }).metadata()).loop).toBe(0);
  expect((await sharp(output.bytes, { animated: true }).metadata()).loop).toBe(3);
});

it("counts every WebP frame with the browser's short-delay threshold", async () => {
  const { bytes } = await motionImage("webp", 5);
  const delays = [0, 1, 10, 11, 100];
  let frame = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString("ascii", offset, offset + 4) === "ANMF") bytes.writeUIntLE(delays[frame++], offset + 20, 3);
    offset += 8 + size + size % 2;
  }
  expect(frame).toBe(delays.length);
  expect(prepareMotionPlayback(Uint8Array.from(bytes).buffer)).toBe(411);
  expect(() => prepareMotionPlayback(Uint8Array.from(bytes.subarray(0, -2)).buffer)).toThrow("Invalid motion image");
});

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

it("rejects duplicate or late extended WebP headers before decoding", async () => {
  const { bytes } = await motionImage("webp", 4);
  const start = bytes.indexOf("VP8X"), header = bytes.subarray(start, start + 18);
  for (const at of [start + 18, bytes.indexOf("ANMF") + 8 + bytes.readUInt32LE(bytes.indexOf("ANMF") + 4)]) {
    const duplicate = Buffer.concat([bytes.subarray(0, at), header, bytes.subarray(at)]);
    duplicate.writeUInt32LE(duplicate.length - 8, 4);
    expect(() => inspectMotion(duplicate)).toThrow("media type");
  }
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
  // Noise stays near its input size when rewritten: 10 frames of 1000 × 1000 come out well above the stored limit.
  const bytes = await sharp(randomBytes(1000 * 1000 * 3 * 10), { raw: { width: 1000, height: 10_000, channels: 3, pageHeight: 1000 } }).webp({ quality: 90, delay: Array(10).fill(100), loop: 0 }).toBuffer();
  expect(bytes.length).toBeLessThan(MEDIA_LIMITS.inputBytes);
  expect(bytes.length).toBeGreaterThan(MOTION_LIMITS.storedBytes);
  await expect(rewriteMedia(bytes)).rejects.toMatchObject({ code: "too_large" });
}, 60_000);

it("lets the database hold a motion version above the still limit, up to its own limit", async () => {
  const row = (n: number, size: number, animated: boolean) => ({ id: (0xabc000 + n).toString(16).padStart(64, "0"), uploadedBy: "motion-author", bytes: Buffer.alloc(size, n), mime: "image/webp", width: 1, height: 1, byteSize: size, animated, frames: animated ? 2 : 1 });
  await db.insert(media).values(row(1, MEDIA_LIMITS.storedBytes + 1, true));
  await expect(db.insert(media).values(row(2, MEDIA_LIMITS.storedBytes + 1, false))).rejects.toThrow();
  await expect(db.insert(media).values(row(3, MOTION_LIMITS.storedBytes + 1, true))).rejects.toThrow();
  await db.delete(media).where(eq(media.id, row(1, 1, true).id));
});

it("fits the longest edge without enlarging and keeps all frames", async () => {
  const input = await motionImage("gif", 3, 2400, 200);
  const output = await rewriteMedia(input.bytes);
  const meta = await sharp(output.bytes, { animated: true }).metadata();
  expect(meta.width).toBe(2000); expect(meta.pageHeight).toBeLessThanOrEqual(200); expect(meta.pages).toBe(3);
  expect(meta.delay).toEqual(input.delay);
});

it("binds explicit authored pairs, visibility, translation exclusion, export and deletion", async () => {
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:5585");
  const rewritten = await rewriteMedia((await motionImage()).bytes);
  const saved = await putUploadedMedia(db, "motion-author", rewritten);
  if (!("posterUrl" in saved) || typeof saved.posterUrl !== "string") throw new Error("poster missing");
  const body = `[![diagram](${saved.posterUrl})](${saved.url})`;
  const ids = referencedMediaIds(body); expect(ids).toHaveLength(2);
  const motionId = parseMediaPath(saved.url)!.id;
  expect(await canReadMedia(db, motionId, null)).toBe(false);
  const created = await createTopic(db, "motion-author", { title: "Motion fixture", body, lang: "en" });
  if (!created.ok) throw new Error(created.error);
  expect(await canReadMedia(db, motionId, null)).toBe(true);
  const html = await renderMarkdown(body);
  const images = await motionImages(db, [html]);
  expect(images.get(motionId)?.durationMs).toBe(rewritten.durationMs);
  expect(decorateMotionHtml(html, html, "motion-author", images)).toContain(`data-motion-duration="${rewritten.durationMs}"`);
  const passive = decorateMotionHtml(html, html, "motion-author", images, false);
  expect(passive).not.toContain("data-motion-open");
  expect(passive).toContain(`href="${saved.url}"`);
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
  await putUploadedMedia(db, "motion-author", rewritten);
  expect(await pairedMedia(db, motionId)).toHaveLength(2);
  const posterId = parseMediaPath(saved.posterUrl)!.id;
  expect((await listOwnMedia(db, "motion-author")).find(image => image.id === posterId)).toMatchObject({ usedByOwnPosts: 0, related: [] });
  expect(await deleteOwnMedia(db, "motion-author", posterId, 0)).toMatchObject({ status: "deleted" });
  expect(await readMedia(db, motionId)).not.toBeNull();
  const actor = { id: "motion-other", scope: { operator: true, langs: [] } };
  expect(await deleteMediaWithLog(db, actor, { id: motionId, reason: "other", note: "Synthetic deletion", confirmedIds: "" })).toMatchObject({ ok: false, error: "confirm_required" });
  expect(await deleteMedia(db, parseMediaPath(replacement.url)!.id)).toBe(true);
  for (const id of [...ids, parseMediaPath(replacement.url)!.id]) expect(await readMedia(db, id)).toBeNull();
});

it("rebuilds relationships from all current posts and removes the last obsolete link", async () => {
  const owner = "motion-edits";
  await addMember(db, owner, "motion_edits");
  const saved = await putUploadedMedia(db, owner, await rewriteMedia((await motionImage()).bytes));
  if (!("posterUrl" in saved) || typeof saved.posterUrl !== "string") throw new Error("poster missing");
  const body = `[![diagram](${saved.posterUrl})](${saved.url})`;
  const first = await createTopic(db, owner, { title: "First diagram", body, lang: "en" });
  const second = await createTopic(db, owner, { title: "Second diagram", body, lang: "en" });
  if (!first.ok || !second.ok) throw new Error("topic missing");
  const motionId = parseMediaPath(saved.url)!.id;
  expect(await editEntry(db, owner, first.id, { body: "No image remains." }, { kind: "topic" })).toMatchObject({ ok: true });
  expect(await pairedMedia(db, motionId)).toHaveLength(2);
  expect(await editEntry(db, owner, second.id, { body: `![diagram](${saved.posterUrl})` }, { kind: "topic" })).toMatchObject({ ok: true });
  expect(await pairedMedia(db, motionId)).toHaveLength(1);
  expect(await deleteMedia(db, motionId)).toBe(true);
  expect(await readMedia(db, parseMediaPath(saved.posterUrl)!.id)).not.toBeNull();
});

it("does not traverse a shared still into another animation when deleting", async () => {
  const owner = "motion-shared";
  await addMember(db, owner, "motion_shared");
  const first = await putUploadedMedia(db, owner, await rewriteMedia((await motionImage("gif", 3)).bytes));
  const second = await putUploadedMedia(db, owner, await rewriteMedia((await motionImage("gif", 4)).bytes));
  if (!("posterUrl" in first) || typeof first.posterUrl !== "string") throw new Error("poster missing");
  const body = `[![first](${first.posterUrl})](${first.url})\n\n[![second](${first.posterUrl})](${second.url})`;
  expect(await createTopic(db, owner, { title: "Shared still", body, lang: "en" })).toMatchObject({ ok: true });
  const firstId = parseMediaPath(first.url)!.id, secondId = parseMediaPath(second.url)!.id;
  expect((await pairedMedia(db, firstId)).map(image => image.id)).not.toContain(secondId);
  expect(await deleteMedia(db, firstId)).toBe(true);
  expect(await readMedia(db, secondId)).not.toBeNull();
});

it("releases an upload pair when only its still is posted", async () => {
  const owner = "motion-still-only";
  await addMember(db, owner, "motion_still_only");
  const rewritten = await rewriteMedia((await motionImage()).bytes);
  const saved = await putUploadedMedia(db, owner, rewritten);
  if (!("posterUrl" in saved) || typeof saved.posterUrl !== "string") throw new Error("poster missing");
  const motionId = parseMediaPath(saved.url)!.id, stillId = parseMediaPath(saved.posterUrl)!.id;
  expect(await createTopic(db, owner, { title: "Still only", body: `![diagram](${saved.posterUrl})`, lang: "en" })).toMatchObject({ ok: true });
  await putUploadedMedia(db, owner, rewritten);
  expect(await pairedMedia(db, motionId)).toHaveLength(1);
  expect((await listOwnMedia(db, owner)).find(image => image.id === motionId)).toMatchObject({ usedByOwnPosts: 0, related: [] });
  expect(await deleteOwnMedia(db, owner, motionId, 0)).toMatchObject({ status: "deleted" });
  expect(await readMedia(db, stillId)).not.toBeNull();
});

it.each([false, true])("excludes identity images from authored and legacy pairs with village icon %s", async village => {
  vi.stubEnv("VILLAGES", "1");
  const owner = village ? "motion-icon" : "motion-avatar";
  await addMember(db, owner, owner.replaceAll("-", "_"));
  const saved = await putUploadedMedia(db, owner, await rewriteMedia((await motionImage()).bytes));
  const motionId = parseMediaPath(saved.url)!.id;
  const icon = await rewriteMedia(await sharp({ create: { width: 40, height: 40, channels: 3, background: "green" } }).png().toBuffer(), { avatar: true });
  let villageId = "";
  if (village) {
    const [place] = await db.insert(villages).values({ slug: "motion-icon", kind: "open", name: "Diagram village" }).returning();
    villageId = place.id;
    await db.insert(villageMembers).values({ villageId, userId: owner, role: "owner" });
  }
  const setImage = (image: typeof icon | null) => village ? setVillageIcon(db, owner, "motion-icon", image) : setMemberAvatar(db, owner, image);
  const identity = await setImage(icon), identityId = parseMediaPath(identity.url!)!.id;
  expect(await createTopic(db, owner, { title: "Identity link", body: `[![identity](${identity.url})](${saved.url})`, lang: "en" })).toMatchObject({ ok: true });
  expect((await pairedMedia(db, motionId)).map(image => image.id)).not.toContain(identityId);
  // Old relationships must also be ignored when reading or deleting groups.
  await db.insert(motionPairs).values({ motionId, stillId: identityId });
  expect((await pairedMedia(db, motionId)).map(image => image.id)).not.toContain(identityId);
  expect((await listOwnMedia(db, owner)).map(image => image.id)).not.toContain(identityId);
  await setImage(null);
  expect(await readMedia(db, identityId)).toBeNull();
  expect(await readMedia(db, motionId)).not.toBeNull();
  const current = await setImage(icon), currentId = parseMediaPath(current.url!)!.id;
  await db.insert(motionPairs).values({ motionId, stillId: currentId });
  expect(await deleteMediaWithLog(db, { id: "motion-other", scope: { operator: true, langs: [] } }, { id: motionId, reason: "other", note: "Remove the animated diagram" })).toMatchObject({ ok: true });
  expect(await readMedia(db, currentId)).not.toBeNull();
  if (village) expect((await db.select().from(villages).where(eq(villages.id, villageId)))[0].iconMediaId).toBe(currentId);
  else expect((await db.select().from(profiles).where(eq(profiles.userId, owner)))[0].avatarMediaId).toBe(currentId);
  await deleteMedia(db, currentId);
  if (village) expect((await db.select().from(villages).where(eq(villages.id, villageId)))[0].iconMediaId).toBeNull();
  else expect((await db.select().from(profiles).where(eq(profiles.userId, owner)))[0].avatarMediaId).toBeNull();
});

it("keeps animated images out of share previews while allowing linked stills", async () => {
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:5585");
  const owner = "motion-share";
  await addMember(db, owner, "motion_share");
  const saved = await putUploadedMedia(db, owner, await rewriteMedia((await motionImage()).bytes));
  if (!("posterUrl" in saved) || typeof saved.posterUrl !== "string") throw new Error("poster missing");
  for (const paired of [false, true]) {
    const body = paired ? `[![diagram](${saved.posterUrl})](${saved.url})` : `![diagram](${saved.url})`;
    const created = await createTopic(db, owner, { title: "Shared diagram", body, lang: "en" });
    if (!created.ok) throw new Error(created.error);
    const [topic] = await db.select().from(entries).where(eq(entries.id, created.id));
    const share = await topicShare(db, { ...topic, lang: "en" }, "");
    if (paired) expect(share.image?.url).toBe(`http://localhost:5585${saved.posterUrl}`);
    else expect(share.image).toBeNull();
  }
});

it("links standalone motion and escapes descriptions exactly once, including over the display cap", async () => {
  const stillId = "a".repeat(64), motionId = "b".repeat(64);
  const still = `/media/${stillId}-10x10.webp`, motion = `/media/${motionId}-10x10.webp`;
  const images = new Map([[stillId, { id: stillId, width: 10, height: 10, animated: false, uploadedBy: "author", durationMs: null }], [motionId, { id: motionId, width: 10, height: 10, animated: true, uploadedBy: "author", durationMs: 1000 }]]);
  const html = await renderMarkdown(`![A & B <tag> "quoted"](${motion})`);
  const shown = decorateMotionHtml(html, html, "author", images);
  expect(shown).toContain(`<a href="${motion}">A &amp; B &lt;tag&gt; &quot;quoted&quot;</a>`);
  expect(shown).not.toContain("&amp;amp;");
  const empty = await renderMarkdown(`![](${motion})`);
  expect(decorateMotionHtml(empty, empty, "author", images)).toContain(`<a href="${motion}">View motion</a>`);
  const linked = `<a href="${motion}"><img src="${motion}" alt="A &amp; B"></a>`;
  expect(decorateMotionHtml(linked, linked, "author", images)).toBe(`<a href="${motion}">A &amp; B</a>`);
  const emptyLinked = `<a href="${motion}"><img src="${motion}" alt=""></a>`;
  expect(decorateMotionHtml(emptyLinked, emptyLinked, "author", images)).toBe(`<a href="${motion}">View motion</a>`);
  const capped = Array(16).fill(`<a href="${motion}"><img src="${still}" alt="A &amp; B &#x3c;script&#62;"></a>`).join("");
  const overflow = decorateMotionHtml(capped, capped, "author", images);
  expect(overflow).toContain(`<a href="${motion}">A &amp; B &lt;script&gt;</a>`);
  expect(overflow).not.toContain("&amp;amp;");
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
