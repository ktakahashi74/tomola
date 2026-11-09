import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import sharp from "sharp";
import { count, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, entryMedia, media, moderationActions, profiles, rateLimits, roles, translations } from "~/lib/db/schema";
import { readMediaForm, rewriteMedia, withMediaSlot } from "~/lib/media-processing.server";
import { deleteMedia, putMedia, readMedia } from "~/lib/media-store.server";
import { MEDIA_LIMITS, mediaPath } from "~/lib/media";
import { action } from "~/routes/media-upload";
import { loader } from "~/routes/media-file";
import { exportSite } from "~/lib/site-export.server";
import { clearMemoryReadLimitsForTests, hitIpLimit, hitRateLimit, READ_RATE_LIMIT } from "~/lib/rate-limit.server";
import { renderMarkdown } from "~/lib/markdown.server";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { checkStructure } from "~/lib/llm/structure.server";
import { markdownToPlainText } from "~/lib/plain-text.server";
import { getReader } from "~/lib/auth/session.server";
import * as mediaStore from "~/lib/media-store.server";
import { formatAccessLog } from "../server/access-log.ts";
import { addMember, closeTestDb, createTestDb } from "./helpers/db";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let db: Db, signedIn = true, sessionMemberId = "media-member";
vi.mock("~/lib/db/client.server", async importOriginal => ({ ...await importOriginal<object>(), getDb: async () => Promise.resolve(db) }));
vi.mock("~/lib/auth/auth.server", () => ({ authBaseURL: () => "http://localhost:5279", getAuth: async () => ({ api: { getSession: async () => ({ headers: new Headers(), response: signedIn ? { user: { id: sessionMemberId, email: "media@example.com", name: "" } } : null }) } }) }));
const origin = "http://localhost:5279";
const png = (width = 80, height = 40) => sharp({ create: { width, height, channels: 4, background: { r: 35, g: 60, b: 90, alpha: 0.75 } } }).png().toBuffer();
let source: Buffer, image: Awaited<ReturnType<typeof rewriteMedia>>;
const upload = (bytes: Uint8Array = source, headers: Record<string, string> = {}) => {
  const form = new FormData();
  form.append("image", new File([new Uint8Array(bytes)], "untrusted.jpg", { type: "text/html" }));
  return new Request(`${origin}/media`, { method: "POST", headers: { Origin: origin, ...headers }, body: form });
};
async function publishImage(url: string) {
  const topic = await createTopic(db, "media-member", { title: "Shared image", body: `![picture](${url})`, lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  return topic.id;
}
const fetchImage = async (url: string, headers: Record<string, string> = {}, method = "GET") => (await loader({ request: new Request(origin + url, { headers, method }) }));
beforeAll(async () => {
  db = await createTestDb();
  await addMember(db, "media-member", "media_member");
  source = await png(); image = await rewriteMedia(source);
});
afterAll(async () => { await closeTestDb(db); });
beforeEach(async () => {
  signedIn = true;
  sessionMemberId = "media-member";
  vi.stubEnv("PUBLIC_READING", "");
  vi.stubEnv("BETTER_AUTH_URL", origin);
  await db.delete(moderationActions).where(eq(moderationActions.action, "delete_media"));
  await db.delete(media); await db.delete(rateLimits); clearMemoryReadLimitsForTests(db);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("image reference visibility", () => {
  it.each([false, true])("ignores another author's visible references to a hidden owner's image (legacy %s)", async legacy => {
    const id = legacy ? createHash("sha256").update(image.bytes).digest("hex") : (await putMedia(db, "media-member", image)).url.split("/").at(-1)!.slice(0, 64);
    if (legacy) await db.insert(media).values({ id, bytes: image.bytes, mime: "image/webp", width: image.width, height: image.height, byteSize: image.bytes.length, uploadedBy: "media-member" });
    const url = mediaPath(id, image.width, image.height);
    const topicId = await publishImage(url);
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topicId));
    const copyingAuthor = `image-copying-author-${legacy}`;
    await addMember(db, copyingAuthor, `sec_copying_author_${Number(legacy)}`);
    expect(await createTopic(db, copyingAuthor, { title: "Copied image URL", body: `![copy](${url})`, lang: "en" })).toMatchObject({ ok: true });
    signedIn = false; vi.stubEnv("PUBLIC_READING", "1");
    expect((await fetchImage(url, { "If-None-Match": "*" })).status).toBe(404);
    signedIn = true; sessionMemberId = copyingAuthor;
    expect((await fetchImage(url)).status).toBe(404);
    sessionMemberId = "media-member";
    expect((await fetchImage(url)).status).toBe(200);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hidden-image-export-"));
    try {
      const outDir = path.join(temporary, "site");
      await exportSite(db, { outDir, langs: ["en"] });
      const assets = await fs.readdir(path.join(outDir, "assets/media")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      expect(assets).not.toContain(`${id}-${image.width}x${image.height}.webp`);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
  it("accepts the owner's deleted upload under a new URL without restoring deleted URLs", async () => {
    const first = await putMedia(db, "media-member", image);
    const firstId = first.url.split("/").at(-1)!.slice(0, 64);
    expect(await mediaStore.deleteOwnMedia(db, "media-member", firstId, 0)).toMatchObject({ status: "deleted" });
    const replacement = await putMedia(db, "media-member", image);
    expect(replacement.url).not.toBe(first.url);
    expect(replacement.url).toMatch(/^\/media\/[a-f0-9]{64}-80x40\.webp$/);
    expect((await fetchImage(first.url)).status).toBe(404);
    expect((await fetchImage(replacement.url)).status).toBe(200);
    expect(await putMedia(db, "media-member", image)).toEqual(replacement);
    await deleteMedia(db, replacement.url.split("/").at(-1)!.slice(0, 64));
    const third = await putMedia(db, "media-member", image);
    expect(third.url).not.toBe(replacement.url);
    expect((await fetchImage(replacement.url)).status).toBe(404);
  });
  it("separates new uploads by owner without changing legacy URLs", async () => {
    await addMember(db, "image-second-owner", "sec_image_second_owner");
    const legacyId = createHash("sha256").update(image.bytes).digest("hex");
    await db.insert(media).values({ id: legacyId, bytes: image.bytes, mime: "image/webp", width: image.width, height: image.height, byteSize: image.bytes.length, uploadedBy: "media-member" });
    const legacyUrl = mediaPath(legacyId, image.width, image.height);
    const first = await putMedia(db, "media-member", image);
    const second = await putMedia(db, "image-second-owner", image);
    expect(first.url).not.toBe(legacyUrl);
    expect(second.url).not.toBe(first.url);
    expect(second.url).not.toBe(legacyUrl);
    expect(second.url).toMatch(/^\/media\/[a-f0-9]{64}-80x40\.webp$/);
    expect(await putMedia(db, "image-second-owner", image)).toEqual(second);
    expect(await db.select({ count: count() }).from(media)).toEqual([{ count: 3 }]);
    expect((await fetchImage(legacyUrl)).status).toBe(200);
    expect((await fetchImage(second.url)).status).toBe(404);
    sessionMemberId = "image-second-owner";
    expect((await fetchImage(second.url)).status).toBe(200);
    expect((await fetchImage(legacyUrl)).status).toBe(404);
    const { action: remove } = await import("~/routes/settings-media");
    const request = (url: string) => new Request(origin + "/settings/media", { method: "POST", headers: { origin }, body: new URLSearchParams({ id: url.split("/").at(-1)!.slice(0, 64), confirm: "1", usage_count: "0" }) });
    await expect(remove({ request: request(legacyUrl) } as never)).rejects.toMatchObject({ init: { status: 404 } });
    expect(await remove({ request: request(second.url) } as never)).toEqual({ deleted: true });
    sessionMemberId = "media-member";
    expect((await fetchImage(first.url)).status).toBe(200);
    expect((await fetchImage(legacyUrl)).status).toBe(200);
  });
  it("requires confirmation of the owner's current post count without exposing other authors' usage", async () => {
    const saved = await putMedia(db, "media-member", image);
    const id = saved.url.split("/").at(-1)!.slice(0, 64);
    await addMember(db, "image-other-author", "sec_image_other_author");
    const ownId = await publishImage(saved.url);
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, ownId));
    const deletedId = await publishImage(saved.url);
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, deletedId));
    expect(await createTopic(db, "image-other-author", { title: "Other author's image", body: `![picture](${saved.url})`, lang: "en" })).toMatchObject({ ok: true });
    const { loader: ownImages, action: remove } = await import("~/routes/settings-media");
    expect((await ownImages({ request: new Request(origin + "/settings/media") } as never)).images).toEqual([expect.objectContaining({ id, usedByOwnPosts: 1 })]);
    const request = (usageCount: string, confirm = "1") => new Request(origin + "/settings/media", { method: "POST", headers: { origin }, body: new URLSearchParams({ id, confirm, usage_count: usageCount }) });
    await expect(remove({ request: request("1", "") } as never)).rejects.toMatchObject({ init: { status: 400 } });
    const stale = await remove({ request: request("0") } as never);
    expect(stale).toMatchObject({ init: { status: 409 }, data: { deleted: false, id, usedByOwnPosts: 1 } });
    expect(await readMedia(db, id)).not.toBeNull();
    expect(await remove({ request: request("1") } as never)).toEqual({ deleted: true });
    expect(await readMedia(db, id)).toBeNull();
  });
  it("follows root visibility, moderator language scope, edits and multiple references", async () => {
    const saved = await putMedia(db, "media-member", image);
    const topic = await createTopic(db, "media-member", { title: "Root", body: "Root body", lang: "en" });
    if (!topic.ok) throw new Error(topic.error);
    const reply = await createReply(db, "media-member", topic.id, { body: `![picture](${saved.url})`, lang: "en" });
    if (!reply.ok) throw new Error(reply.error);
    expect(await db.select().from(entryMedia).where(eq(entryMedia.mediaId, saved.url.split("/").at(-1)!.slice(0, 64)))).toHaveLength(1);
    await db.update(entries).set({ hiddenAt: new Date(), deletedAt: new Date() }).where(eq(entries.id, topic.id));
    signedIn = false; vi.stubEnv("PUBLIC_READING", "1");
    expect((await fetchImage(saved.url)).status).toBe(404);
    await addMember(db, "image-moderator", "sec_image_moderator");
    await db.insert(roles).values({ userId: "image-moderator", role: "moderator", lang: "ja" });
    signedIn = true; sessionMemberId = "image-moderator";
    expect((await fetchImage(saved.url)).status).toBe(404);
    await db.insert(roles).values({ userId: "image-moderator", role: "moderator", lang: "en" });
    expect((await fetchImage(saved.url)).status).toBe(200);
    sessionMemberId = "media-member";
    await db.update(entries).set({ hiddenAt: null, deletedAt: null }).where(eq(entries.id, topic.id));
    expect(await editEntry(db, "media-member", reply.id, { body: "Image removed" }, { kind: "reply" })).toMatchObject({ ok: true });
    signedIn = false;
    expect((await fetchImage(saved.url)).status).toBe(404);
    signedIn = true; expect((await fetchImage(saved.url)).status).toBe(200);
    const visible = await publishImage(saved.url);
    signedIn = false; expect((await fetchImage(saved.url)).status).toBe(200);
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, visible));
    expect((await fetchImage(saved.url)).status).toBe(404);
  });
  it("keeps an orphan private to its uploader, including conditional requests", async () => {
    await addMember(db, "image-reader", "sec_image_reader");
    const saved = await putMedia(db, "media-member", image);
    expect((await fetchImage(saved.url)).status).toBe(200);
    sessionMemberId = "image-reader";
    expect((await fetchImage(saved.url)).status).toBe(404);
    expect((await fetchImage(saved.url, { "If-None-Match": "*" })).status).toBe(404);
    signedIn = false; vi.stubEnv("PUBLIC_READING", "1");
    expect((await fetchImage(saved.url)).status).toBe(404);
  });
  it("withdraws hidden and deleted references before 304, while preserving author and scoped moderation reads", async () => {
    const saved = await putMedia(db, "media-member", image);
    const topic = await createTopic(db, "media-member", { title: "Image visibility", body: `![picture](${saved.url})`, lang: "en" });
    if (!topic.ok) throw new Error(topic.error);
    signedIn = false; vi.stubEnv("PUBLIC_READING", "1");
    expect((await fetchImage(saved.url)).status).toBe(200);
    for (const field of ["hiddenAt", "deletedAt"] as const) {
      await db.update(entries).set({ [field]: new Date() }).where(eq(entries.id, topic.id));
      expect((await fetchImage(saved.url, { "If-None-Match": "*" })).status).toBe(404);
      signedIn = true;
      expect((await fetchImage(saved.url)).status).toBe(200);
      signedIn = false;
    }
  });
  it("authorizes owner deletion and records operator deletion atomically", async () => {
    const saved = await putMedia(db, "media-member", image);
    const id = saved.url.split("/").at(-1)!.slice(0, 64);
    const { action: remove } = await import("~/routes/settings-media");
    const request = () => new Request(origin + "/settings/media", { method: "POST", headers: { origin }, body: new URLSearchParams({ id, confirm: "1", usage_count: "0" }) });
    await addMember(db, "image-stranger", "sec_image_stranger");
    sessionMemberId = "image-stranger";
    await expect(remove({ request: request() } as never)).rejects.toMatchObject({ init: { status: 404 } });
    expect(await readMedia(db, id)).not.toBeNull();
    const { deleteMediaWithLog } = await import("~/lib/media-store.server");
    expect(await deleteMediaWithLog(db, { id: "image-stranger", scope: { operator: false, langs: ["en"] } }, { id, reason: "spam", note: "Disallowed picture" })).toEqual({ ok: false, error: "forbidden" });
    const before = await db.select().from(moderationActions);
    expect(await deleteMediaWithLog(db, { id: "image-stranger", scope: { operator: true, langs: [] } }, { id, reason: "spam", note: "Disallowed picture" })).toEqual({ ok: true });
    expect(await readMedia(db, id)).toBeNull();
    expect(await db.select().from(moderationActions)).toHaveLength(before.length + 1);
    expect((await db.select().from(moderationActions)).at(-1)).toMatchObject({ action: "delete_media", targetMediaId: id, actorId: "image-stranger", reason: "spam" });
    const own = await putMedia(db, "media-member", await rewriteMedia(await png(13, 11)));
    sessionMemberId = "media-member";
    expect(await remove({ request: new Request(origin + "/settings/media", { method: "POST", headers: { origin }, body: new URLSearchParams({ id: own.url.split("/").at(-1)!.slice(0, 64), confirm: "1", usage_count: "0" }) }) } as never)).toEqual({ deleted: true });
    expect((await fetchImage(own.url)).status).toBe(404);
  });
});

describe("untrusted image conversion", () => {
  it("detects contents, removes all metadata, and applies orientation before removing it", async () => {
    const jpeg = await sharp({ create: { width: 100, height: 40, channels: 3, background: "red" } })
      .withMetadata({ orientation: 6 }).withExifMerge({ IFD0: { ImageDescription: "private-camera" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><private>location</private></x:xmpmeta>').jpeg().toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const result = await rewriteMedia(jpeg), metadata = await sharp(result.bytes).metadata();
    expect(result).toMatchObject({ width: 40, height: 100 });
    expect(metadata.format).toBe("webp");
    for (const key of ["exif", "xmp", "icc", "iptc", "orientation", "comments"]) expect(metadata[key as keyof typeof metadata]).toBeUndefined();
    expect(result.bytes.includes(Buffer.from("private-camera"))).toBe(false);
  });
  it("resizes inside 2000 pixels and does not enlarge small images", async () => {
    expect(await rewriteMedia(await png(3000, 1500))).toMatchObject({ width: 2000, height: 1000 });
    expect(image).toMatchObject({ width: 80, height: 40 });
  });
  it("preserves diagram pixels and transparency for PNG input", async () => {
    const original = await sharp(source).raw().toBuffer(), output = await sharp(image.bytes).raw().toBuffer();
    expect(output).toEqual(original);
    expect((await sharp(image.bytes).metadata()).hasAlpha).toBe(true);
  });
  it("retries oversized lossless output once and rejects images still above the stored limit", async () => {
    const raw = randomBytes(1400 * 1400 * 3);
    const diagram = await sharp(raw, { raw: { width: 1400, height: 1400, channels: 3 } }).png().toBuffer();
    expect((await sharp(diagram).webp({ lossless: true }).toBuffer()).length).toBeGreaterThan(MEDIA_LIMITS.storedBytes);
    expect((await rewriteMedia(diagram)).bytes.length).toBeLessThanOrEqual(MEDIA_LIMITS.storedBytes);
    const photo = await sharp(randomBytes(2000 * 2000 * 3), { raw: { width: 2000, height: 2000, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    expect(photo.length).toBeLessThan(MEDIA_LIMITS.inputBytes);
    await expect(rewriteMedia(photo)).rejects.toMatchObject({ code: "too_large" });
  }, 30_000);
  it("also accepts still WebP", async () => { expect(await rewriteMedia(image.bytes)).toMatchObject({ width: 80, height: 40 }); });
  it.each([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from("GIF89a"), Buffer.from("<html>image.png</html>"), Buffer.from("not an image"), Buffer.from("\0\0\0\x18ftypheic")])("rejects non-image and unsupported contents", async bytes => {
    await expect(rewriteMedia(bytes)).rejects.toMatchObject({ code: "type" });
  });
  it("rejects damaged or truncated images and remains usable afterwards", async () => {
    await expect(rewriteMedia(source.subarray(0, 30))).rejects.toMatchObject({ code: "generic" });
    expect(await rewriteMedia(source)).toMatchObject({ width: 80 });
  });
  it("rejects input bytes and pixel counts before image decompression", async () => {
    await expect(rewriteMedia(Buffer.alloc(MEDIA_LIMITS.inputBytes + 1))).rejects.toMatchObject({ code: "too_large" });
    await expect(rewriteMedia(await png(7000, 6000))).rejects.toMatchObject({ code: "too_large" });
  }, 30_000);
  it("rejects animated WebP and PNG", async () => {
    const animated = await sharp({ create: { width: 8, height: 16, channels: 3, background: "red" } }).raw().toBuffer();
    animated.fill(0, animated.length / 2);
    const webp = await sharp(animated, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(webp, { animated: true }).metadata()).pages).toBe(2);
    await expect(rewriteMedia(webp)).rejects.toMatchObject({ code: "type" });
    const chunk = Buffer.alloc(20); chunk.writeUInt32BE(8); chunk.write("acTL", 4);
    await expect(rewriteMedia(Buffer.concat([source.subarray(0, 33), chunk, source.subarray(33)]))).rejects.toMatchObject({ code: "type" });
  });
});

describe("bounded input and concurrency", () => {
  it("continues serving uploads after malformed input and concurrent native decoding", async () => {
    const malformed = await action({ request: new Request(origin + "/media", { method: "POST", headers: { Origin: origin, "Content-Type": "multipart/form-data; boundary=a" }, body: "--a\r\nunfinished" }) });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "generic" });
    const responses = await Promise.all(Array.from({ length: MEDIA_LIMITS.concurrent + 1 }, () => action({ request: upload() })));
    for (const response of responses) expect([201, 503]).toContain(response.status);
    expect(responses.some(response => response.status === 201)).toBe(true);
    expect((await action({ request: upload() })).status).toBe(201);
  });
  it("accepts one multipart file regardless of its filename and declared type", async () => { expect((await readMediaForm(upload())).size).toBe(source.length); });
  it("rejects extra files, truncated multipart and interrupted streams", async () => {
    const multiple = new FormData(); multiple.append("image", new File([new Uint8Array(source)], "a.png")); multiple.append("image", new File([new Uint8Array(source)], "b.png"));
    await expect(readMediaForm(new Request(origin + "/media", { method: "POST", body: multiple }))).rejects.toMatchObject({ code: "generic" });
    await expect(readMediaForm(new Request(origin + "/media", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=a" }, body: "--a\r\nunfinished" }))).rejects.toMatchObject({ code: "generic" });
    const body = new ReadableStream({ start(c) { c.error(new Error("connection interrupted")); } });
    await expect(readMediaForm(new Request(origin + "/media", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=a" }, body, duplex: "half" } as RequestInit))).rejects.toMatchObject({ code: "generic" });
  });
  it("bounds announced and streamed bodies before multipart parsing", async () => {
    await expect(readMediaForm(upload(source, { "Content-Length": String(MEDIA_LIMITS.requestBytes + 1) }))).rejects.toMatchObject({ code: "too_large" });
    const body = new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(MEDIA_LIMITS.requestBytes + 1)); c.close(); } });
    await expect(readMediaForm(new Request(origin + "/media", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=a" }, body, duplex: "half" } as RequestInit))).rejects.toMatchObject({ code: "too_large" });
  });
  it("bounds simultaneous work and releases slots after failures", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const running = Array.from({ length: MEDIA_LIMITS.concurrent }, () => withMediaSlot(() => gate));
    await expect(withMediaSlot(async () => {})).rejects.toMatchObject({ status: 503 });
    release(); await Promise.all(running);
    await expect(withMediaSlot(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(withMediaSlot(async () => 1)).resolves.toBe(1);
  });
});

describe("storage, writer and reader boundaries", () => {
  it("stores only rewritten bytes, hashes them, and deduplicates repeated uploads", async () => {
    const a = await action({ request: upload() }), b = await action({ request: upload() });
    expect(a.status).toBe(201); const saved = await a.json(); expect(await b.json()).toEqual(saved);
    const [row] = await db.select().from(media);
    expect(row.id).toMatch(/^[a-f0-9]{64}$/);
    expect(row.bytes).toEqual(image.bytes); expect(row.bytes).not.toEqual(source);
    expect(await db.select({ count: count() }).from(media)).toEqual([{ count: 1 }]);
  });
  it("checks origin before authentication or consuming the request body", async () => {
    signedIn = false;
    await expect(action({ request: upload(source, { Origin: "https://outside.example" }) })).rejects.toMatchObject({ init: { status: 403 } });
    await expect(action({ request: upload() })).rejects.toMatchObject({ status: 302 });
  });
  it("rejects suspended writers", async () => {
    await db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 3600000) }).where(eq(profiles.userId, "media-member"));
    try { await expect(action({ request: upload() })).rejects.toMatchObject({ status: 302 }); }
    finally { await db.update(profiles).set({ suspendedUntil: null }).where(eq(profiles.userId, "media-member")); }
  });
  it("limits attempts to thirty per hour without logging identifiers", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map(method => vi.spyOn(console, method as "log").mockImplementation(() => {}));
    for (let i = 0; i < MEDIA_LIMITS.hourly; i++) expect((await action({ request: upload(Buffer.from("not an image")) })).status).toBe(400);
    const response = await action({ request: upload() });
    expect(response.status).toBe(429); expect(await response.json()).toEqual({ error: "rate" });
    expect(response.headers.get("retry-after")).not.toBeNull();
    const saved = await putMedia(db, "media-member", image), id = saved.url.split("/").at(-1)!.slice(0, 64);
    expect((await fetchImage(saved.url)).status).toBe(200);
    expect((await fetchImage(mediaPath("f".repeat(64), 80, 40))).status).toBe(404);
    const recorded = logs.flatMap(log => log.mock.calls).map(args => JSON.stringify(args)).join("\n");
    expect(recorded).not.toContain(id); expect(recorded).not.toContain("media-member");
    for (const [method, url, status] of [["POST", "/media?member=media-member", 429], ["GET", saved.url + "?member=media-member", 200]] as const) {
      const line = formatAccessLog({ method, url, status, bytes: null, ms: 1 });
      expect(line).toContain("/media/[redacted]"); expect(line).not.toContain(id); expect(line).not.toContain("media-member");
    }
  }, 30_000);
  it("enforces the live-image quota, allows deduplication, and excludes deleted rows", async () => {
    await db.insert(media).values(Array.from({ length: MEDIA_LIMITS.storedCount }, (_, i) => ({ id: i.toString(16).padStart(64, "0"), bytes: image.bytes, mime: "image/webp", width: 80, height: 40, byteSize: image.bytes.length, uploadedBy: "media-member" })));
    await expect(putMedia(db, "media-member", image)).rejects.toMatchObject({ code: "quota" });
    await deleteMedia(db, "0".repeat(64));
    const saved = await putMedia(db, "media-member", image);
    expect(saved.url).toMatch(/^\/media\/[a-f0-9]{64}-80x40\.webp$/);
    await expect(putMedia(db, "media-member", image)).resolves.toEqual(saved);
  });
  it("serializes the quota check for concurrent uploads by the same member", async () => {
    await db.insert(media).values(Array.from({ length: MEDIA_LIMITS.storedCount - 1 }, (_, i) => ({ id: i.toString(16).padStart(64, "0"), bytes: image.bytes, mime: "image/webp", width: 80, height: 40, byteSize: image.bytes.length, uploadedBy: "media-member" })));
    const other = await rewriteMedia(await png(10, 10));
    const results = await Promise.allSettled([putMedia(db, "media-member", image), putMedia(db, "media-member", other)]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(results.find(row => row.status === "rejected")).toMatchObject({ reason: { code: "quota" } });
    expect(await db.select({ count: count() }).from(media)).toEqual([{ count: MEDIA_LIMITS.storedCount }]);
  });
  it("uses fixed safe headers, private caching, ID lookup and conditional requests", async () => {
    const saved = await putMedia(db, "media-member", image);
    const response = await fetchImage(saved.url);
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(image.bytes);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400");
    expect((await fetchImage(saved.url, { "If-None-Match": `W/${response.headers.get("etag")}` })).status).toBe(304);
    const head = await fetchImage(saved.url, {}, "HEAD"); expect(await head.text()).toBe(""); expect(head.headers.get("content-length")).toBe(String(image.bytes.length));
    for (const dimensions of ["1x1", "80x41", "81x40", "2001x40"]) {
      expect((await fetchImage(saved.url.replace("80x40", dimensions))).status).toBe(404);
      expect((await fetchImage(saved.url.replace("80x40", dimensions), { "If-None-Match": response.headers.get("etag")! })).status).toBe(404);
    }
  });
  it("conceals anonymous private reads and allows anonymous public reads", async () => {
    const saved = await putMedia(db, "media-member", image); await publishImage(saved.url); signedIn = false;
    expect((await fetchImage(saved.url)).status).toBe(404);
    vi.stubEnv("PUBLIC_READING", "1");
    const publicImage = await fetchImage(saved.url);
    expect(publicImage.status).toBe(200); expect(publicImage.headers.get("cache-control")).toBe("private, max-age=86400");
    const unchanged = await fetchImage(saved.url, { "If-None-Match": publicImage.headers.get("etag")! });
    expect(unchanged.status).toBe(304); expect(unchanged.headers.get("cache-control")).toBe("private, max-age=86400");
  });
  it.each([false, true])("image reads leave page counters unchanged, including missing IDs and exhausted counters (public=%s)", async publicReader => {
    const saved = await putMedia(db, "media-member", image);
    const headers = { "X-Forwarded-For": "192.0.2.239" };
    if (publicReader) { await publishImage(saved.url); signedIn = false; vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("TRUSTED_PROXY_HOPS", "1"); }
    for (let i = 0; i < 10; i++) {
      expect((await fetchImage(saved.url, headers)).status).toBe(200);
      expect((await fetchImage(mediaPath("f".repeat(64), 80, 40), headers)).status).toBe(404);
    }
    const pageKey = publicReader ? "ip:public-read:192.0.2.239" : "read:member:media-member";
    const imageKey = publicReader ? "ip:media-read:192.0.2.239" : "media-read:member:media-member";
    expect(await db.select().from(rateLimits).where(eq(rateLimits.key, pageKey))).toHaveLength(0);
    const [imageCounter] = await db.select().from(rateLimits).where(eq(rateLimits.key, imageKey));
    expect(imageCounter.count).toBe(20);
    await getReader(new Request(origin + "/t/1", { headers }));
    const pageHit = () => publicReader
      ? hitIpLimit(db, new Request(origin + "/t/1", { headers }), "public-read")
      : hitRateLimit(db, { key: pageKey, ...READ_RATE_LIMIT });
    expect((await pageHit())?.count).toBe(2);
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, imageKey)))[0].count).toBe(20);
    for (let i = 2; i < READ_RATE_LIMIT.limit; i++) await pageHit();
    const response = await fetchImage(saved.url, headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect((await fetchImage(mediaPath("f".repeat(64), 80, 40), headers)).status).toBe(404);
    expect(await db.select().from(rateLimits).where(eq(rateLimits.key, pageKey))).toEqual([]);
    await expect(getReader(new Request(origin + "/t/1", { headers }))).rejects.toMatchObject({ init: { status: 429 } });
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, imageKey)))[0].count).toBe(22);
  });
  it.each([false, true])("limits image reads before binary lookup, counts conditional requests and keeps safe denial headers (public=%s)", async publicReader => {
    const saved = await putMedia(db, "media-member", image);
    const headers = { "X-Forwarded-For": "192.0.2.239" };
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    if (publicReader) { await publishImage(saved.url); signedIn = false; vi.stubEnv("PUBLIC_READING", "1"); }
    const key = publicReader ? "ip:media-read:192.0.2.239" : "media-read:member:media-member";
    const limit = publicReader ? MEDIA_LIMITS.anonymousReadsHourly : MEDIA_LIMITS.memberReadsHourly;
    expect(limit).toBe(publicReader ? 3000 : 6000);
    expect(MEDIA_LIMITS.readWindowSeconds).toBe(3600);
    const first = await fetchImage(saved.url, headers);
    expect(first.status).toBe(200);
    const [counter] = await db.select().from(rateLimits).where(eq(rateLimits.key, key));
    expect(counter.count).toBe(1);
    expect(counter.expiresAt.getTime() - counter.windowStart.getTime()).toBe(3600 * 1000);
    await db.update(rateLimits).set({ count: limit - 1 }).where(eq(rateLimits.key, key));
    const lookup = vi.spyOn(mediaStore, "readMedia");
    expect((await fetchImage(saved.url, { ...headers, "If-None-Match": first.headers.get("etag")! })).status).toBe(304);
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, key)))[0].count).toBe(limit);
    const refused = await fetchImage(saved.url, { ...headers, "If-None-Match": first.headers.get("etag")! });
    expect(refused.status).toBe(429); expect(await refused.text()).toBe("");
    expect(refused.headers.get("content-type")).toBe("image/webp");
    expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
    expect(refused.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(refused.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(refused.headers.get("x-ratelimit-limit")).toBe(String(limit));
    expect(refused.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(refused.headers.get("x-ratelimit-reset")).toBe(String(Math.ceil(counter.expiresAt.getTime() / 1000)));
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(3600);
    const missing = await fetchImage(mediaPath("f".repeat(64), 80, 40), headers);
    expect(missing.status).toBe(429);
    expect(lookup).toHaveBeenCalledTimes(1);
    const pageKey = publicReader ? "ip:public-read:192.0.2.239" : "read:member:media-member";
    expect(await db.select().from(rateLimits).where(eq(rateLimits.key, pageKey))).toHaveLength(0);
    await getReader(new Request(origin + "/t/1", { headers }));
    expect(await db.select().from(rateLimits).where(eq(rateLimits.key, pageKey))).toEqual([]);
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, key)))[0].count).toBe(limit + 2);
  });
  it("separates member media keys from anonymous IP keys and upload keys", async () => {
    const saved = await putMedia(db, "media-member", image); await publishImage(saved.url);
    vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const sameIP = { "X-Forwarded-For": "192.0.2.239" }, otherIP = { "X-Forwarded-For": "192.0.2.238" };
    expect((await fetchImage(saved.url, sameIP)).status).toBe(200);
    expect((await fetchImage(saved.url, otherIP, "HEAD")).status).toBe(200);
    await addMember(db, "other-media-reader", "other_media_reader"); sessionMemberId = "other-media-reader";
    expect((await fetchImage(saved.url, sameIP)).status).toBe(200);
    sessionMemberId = "media-member";
    expect((await action({ request: upload() })).status).toBe(201);
    signedIn = false;
    expect((await fetchImage(saved.url, sameIP)).status).toBe(200);
    expect((await fetchImage(saved.url, otherIP)).status).toBe(200);
    const counters = Object.fromEntries((await db.select().from(rateLimits)).map(row => [row.key, row.count]));
    expect(counters).toEqual({ "media-read:member:media-member": 2, "media-read:member:other-media-reader": 1, "media:member:media-member": 1, "ip:media-read:192.0.2.239": 1, "ip:media-read:192.0.2.238": 1 });
  });
  it("uses the page-reading trusted-proxy and IPv6 normalization rules for anonymous images", async () => {
    const saved = await putMedia(db, "media-member", image); await publishImage(saved.url);
    signedIn = false; vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    const headers = { "X-Forwarded-For": "192.0.2.1, [2001:db8:abcd:1234::1]:5000, 192.0.2.200" };
    expect((await fetchImage(saved.url, headers)).status).toBe(200);
    expect((await fetchImage(saved.url, { "X-Forwarded-For": "192.0.2.2, 2001:db8:abcd:1234::2, 192.0.2.200" })).status).toBe(200);
    await getReader(new Request(origin + "/t/1", { headers }));
    expect(Object.fromEntries((await db.select().from(rateLimits)).map(row => [row.key, row.count]))).toEqual({ "ip:media-read:2001:db8:abcd:1234::/64": 2 });
  });
  it("does not let an incomplete signed-in registration bypass membership in either reading mode", async () => {
    const saved = await putMedia(db, "media-member", image);
    sessionMemberId = "not-onboarded";
    expect((await fetchImage(saved.url)).status).toBe(404);
    vi.stubEnv("PUBLIC_READING", "1");
    expect((await fetchImage(saved.url)).status).toBe(404);
  });
  it("does not charge attempts refused because every decoder slot is occupied", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const occupied = Array.from({ length: MEDIA_LIMITS.concurrent }, () => withMediaSlot(() => gate));
    try {
      const response = await action({ request: upload() });
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "generic" });
      expect(await db.select().from(rateLimits)).toHaveLength(0);
    } finally { release(); await Promise.all(occupied); }
    expect((await action({ request: upload() })).status).toBe(201);
    expect((await db.select().from(rateLimits))[0].count).toBe(1);
  });
  it("slow receivers do not occupy decoder slots", async () => {
    const complete = upload(), encoded = new Uint8Array(await complete.arrayBuffer());
    const waiting: { received: Promise<void>; finish: () => void; result: Promise<Response> }[] = [];
    for (let i = 0; i < MEDIA_LIMITS.concurrent; i++) {
      let controller!: ReadableStreamDefaultController<Uint8Array>, receiving!: () => void;
      const received = new Promise<void>(resolve => { receiving = resolve; });
      const request = new Request(origin + "/media", { method: "POST", headers: complete.headers, body: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), duplex: "half" } as RequestInit);
      const read = request.body!.getReader.bind(request.body);
      vi.spyOn(request.body!, "getReader").mockImplementation(() => { receiving(); return read(); });
      const result = action({ request });
      waiting.push({ received, result, finish: () => { controller.enqueue(encoded); controller.close(); } });
    }
    try {
      await Promise.all(waiting.map(job => job.received));
      expect((await action({ request: upload() })).status).toBe(201);
      expect((await db.select().from(rateLimits))[0].count).toBe(1);
    } finally { (await Promise.all(waiting.map(async job => (await job.finish())))); await Promise.all(waiting.map(job => job.result)); }
  });
  describe("receive admission", () => {
    const pending: { finish: () => void; result: Promise<Response> }[] = [];
    // Starts an upload whose body stays incomplete until finish() is called; resolves once the route began reading it.
    const slowUpload = async () => {
      const complete = upload(), encoded = new Uint8Array(await complete.arrayBuffer());
      let controller!: ReadableStreamDefaultController<Uint8Array>, reading!: () => void;
      const started = new Promise<void>(resolve => { reading = resolve; });
      const request = new Request(origin + "/media", { method: "POST", headers: complete.headers, body: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), duplex: "half" } as RequestInit);
      const read = request.body!.getReader.bind(request.body);
      vi.spyOn(request.body!, "getReader").mockImplementation(() => { reading(); return read(); });
      let done = false;
      const job = { finish: () => { if (done) return; done = true; controller.enqueue(encoded); controller.close(); }, result: action({ request }) };
      pending.push(job);
      await Promise.race([started, job.result]);
      return job;
    };
    afterEach(async () => { (await Promise.all(pending.map(async job => (await job.finish())))); await Promise.all(pending.map(job => job.result)); pending.length = 0; });
    const refusedUnread = async () => {
      const request = upload(), response = await action({ request });
      expect(request.body!.locked).toBe(false);
      return response;
    };
    it("refuses further bodies from a member who already has the per-member number incomplete, without reading them", async () => {
      for (let i = 0; i < MEDIA_LIMITS.receivingPerMember; i++) await slowUpload();
      const response = await refusedUnread();
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "generic" });
      expect(await db.select().from(rateLimits)).toHaveLength(0);
    });
    it("bounds incomplete bodies across all members and keeps other members' uploads possible below the bound", async () => {
      const members = Math.ceil(MEDIA_LIMITS.receiving / MEDIA_LIMITS.receivingPerMember) + 1;
      for (let m = 0; m < members; m++) await addMember(db, `recv-member-${m}`, `recv_member_${m}`);
      let started = 0;
      for (let m = 0; m < members && started < MEDIA_LIMITS.receiving; m++) {
        sessionMemberId = `recv-member-${m}`;
        for (let i = 0; i < MEDIA_LIMITS.receivingPerMember && started < MEDIA_LIMITS.receiving; i++, started++) await slowUpload();
      }
      sessionMemberId = `recv-member-${members - 1}`;
      expect((await refusedUnread()).status).toBe(503);
    });
    it("frees receive slots when a body is rejected or completes", async () => {
      for (let i = 0; i < MEDIA_LIMITS.receivingPerMember * 2; i++) {
        const bad = new Request(origin + "/media", { method: "POST", headers: { Origin: origin, "content-type": "text/plain" }, body: "x" });
        expect((await action({ request: bad })).status).toBe(400);
      }
      const jobs = [];
      for (let i = 0; i < MEDIA_LIMITS.receivingPerMember; i++) jobs.push(await slowUpload());
      for (const job of jobs) { (await job.finish()); expect((await job.result).status).toBe(201); }
      expect((await action({ request: upload() })).status).toBe(201);
    });
  });
  it("slow database saves do not occupy decoder slots", async () => {
    const original = mediaStore.putMedia;
    let release!: () => void, arrived!: () => void, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const saving = new Promise<void>(resolve => { arrived = resolve; });
    vi.spyOn(mediaStore, "putMedia").mockImplementation(async (...args) => {
      const waiting = ++calls <= MEDIA_LIMITS.concurrent;
      if (calls === MEDIA_LIMITS.concurrent) arrived();
      if (waiting) await gate;
      return original(...args);
    });
    const results = Array.from({ length: MEDIA_LIMITS.concurrent }, () => action({ request: upload() }));
    try { await saving; expect((await action({ request: upload() })).status).toBe(201); }
    finally { release(); await Promise.all(results); }
    expect((await db.select().from(rateLimits))[0].count).toBe(3);
  });
  it("deletes binary content, records deletion and never restores a deleted ID", async () => {
    const saved = await putMedia(db, "media-member", image), id = saved.url.split("/").at(-1)!.slice(0, 64), at = new Date();
    expect(await deleteMedia(db, id, at)).toBe(true); expect(await deleteMedia(db, id)).toBe(false);
    const [row] = await db.select().from(media); expect(row.bytes).toBeNull(); expect(row.deletedAt).toEqual(at);
    expect(await readMedia(db, id)).toBeNull(); expect((await fetchImage(saved.url)).status).toBe(404);
    const replacement = await putMedia(db, "media-member", image);
    expect(replacement.url).not.toBe(saved.url);
    expect(await readMedia(db, id)).toBeNull();
  });
  it("rejects unsafe binary rows at the database boundary", async () => {
    await expect(db.insert(media).values({ id: "f".repeat(64), bytes: image.bytes, byteSize: 1, width: 80, height: 40, mime: "image/webp", uploadedBy: "media-member" })).rejects.toThrow();
  });
});

it("exports only referenced public images into HTML and Markdown, preserving alt text", async () => {
  const saved = await putMedia(db, "media-member", image);
  const privateImage = await putMedia(db, "media-member", await rewriteMedia(await png(10, 10)));
  const body = `![source diagram](${saved.url})\n\n![external](https://outside.example/x.png)\n\n<script>alert(1)</script>`;
  expect((await markdownToPlainText(body))).toContain("source diagram"); expect((await markdownToPlainText(body))).not.toContain("![");
  const [topic] = await db.insert(entries).values({ kind: "topic", authorId: "media-member", lang: "ja", title: "Diagram", body, sourceHash: "media-body" }).returning({ id: entries.id });
  const { syncMediaReferences } = await import("~/lib/media-references.server");
  await syncMediaReferences(db, topic.id, body);
  const [hidden] = await db.insert(entries).values({ kind: "topic", authorId: "media-member", lang: "ja", body: `![hidden](${privateImage.url})`, sourceHash: "hidden-media", hiddenAt: new Date() }).returning({ id: entries.id });
  const translated = `![translated diagram](${saved.url})`;
  await db.insert(translations).values({ entryId: topic.id, field: "body", lang: "en", kind: "primary", sourceHash: "media-body", text: translated });
  expect((await renderMarkdown(translated))).toContain('<img ');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "media-export-"));
  try {
    const outDir = path.join(temporary, "site"); await exportSite(db, { outDir, langs: ["ja", "en"] });
    const assets = await fs.readdir(path.join(outDir, "assets/media")); expect(assets).toHaveLength(1);
    expect(await fs.readFile(path.join(outDir, "assets/media", assets[0]))).toEqual(image.bytes);
    const html = await fs.readFile(path.join(outDir, `en/t/${topic.id}.html`), "utf8");
    const markdown = await fs.readFile(path.join(outDir, `en/t/${topic.id}.md`), "utf8");
    expect(html).toContain(`src="../../assets/media/${assets[0]}"`); expect(html).toContain('alt="translated diagram"');
    expect(html).not.toContain("<script"); expect(html).not.toContain('src="https://');
    expect(markdown).toContain(`![translated diagram](<../../assets/media/${assets[0]}>)`);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); await db.delete(translations).where(eq(translations.entryId, topic.id)); await db.delete(entries).where(inArray(entries.id, [topic.id, hidden.id])); }
}, 30_000);


it("translation permits different alt text and detects changed image destinations", async () => {
  const url = mediaPath("a".repeat(64), 12, 8);
  expect((await checkStructure(`![図](${url})`, `![diagram](${url})`)).ok).toBe(true);
  expect((await checkStructure(`![図][asset]\n\n[asset]: ${url}`, `![diagram][asset]\n\n[asset]: ${url.replace("12x8", "13x8")}`)).flags).toContain("link_mismatch");
  expect((await checkStructure(`![図](${url})`, `![diagram](${url.replace("12x8", "13x8")})`)).flags).toContain("link_mismatch");
});


it("keeps the first definition when repeated image reference labels disagree", async () => {
  const url = mediaPath("a".repeat(64), 12, 8);
  const md = `![figure][asset]\n\n[asset]: ${url}\n[asset]: /unrelated`;
  expect((await checkStructure(md, `![translated][asset]\n\n[asset]: ${url}`)).ok).toBe(true);
});
