import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { avatarSeed, avatarSvg, automaticAvatarUrl, AVATAR_EDGE } from "~/lib/avatar-image.server";
import { exportMemberAvatar, loadMemberAvatars, setMemberAvatar } from "~/lib/member-avatar.server";
import { createAvatarReport, moderateAvatar, loadAvatarReportCards } from "~/lib/avatar-moderation.server";
import { rewriteMedia } from "~/lib/media-processing.server";
import { deleteMedia, deleteOwnMedia, listOwnMedia, readMediaBatch } from "~/lib/media-store.server";
import { createTopic } from "~/lib/entries.server";
import { canReadMedia } from "~/lib/media-references.server";
import { media, moderationActions, notifications, profiles, reports } from "~/lib/db/schema";
import { createAppeal, decideAppeal, getAppealableAction, listOpenAppeals } from "~/lib/appeals.server";
import { listReportCards } from "~/lib/moderation.server";
import { buildMemberExport, MEMBER_EXPORT_VERSION } from "~/lib/exports.server";
import { deleteAccount } from "~/lib/account-delete.server";
import { parseMediaPath } from "~/lib/media";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
let image: Awaited<ReturnType<typeof rewriteMedia>>;
let source: Buffer;
const scope = { operator: true, langs: [] } as const;
const actor = (name = "av_operator") => ({ id: h.ids[name], scope });
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const name of ["av_writer", "av_reporter", "av_operator", "av_reviewer", "av_departing", "av_upload", "av_changed", "av_dismiss", "av_unreported", "av_evidence", "av_erased"]) await h.signIn(name, { homeArea: "en", readLangs: ["en"] });
  source = await sharp({ create: { width: 40, height: 80, channels: 3, background: "#789" } }).withExif({ IFD0: { Artist: "Private camera owner", Orientation: "6" } }).jpeg().toBuffer();
  image = await rewriteMedia(source, { avatar: true });
});
afterAll(() => h.restore());

describe("member avatars", () => {
  it("keeps handled report cards readable after an operator erases their image", async () => {
    const saved = await setMemberAvatar(h.db, h.ids.av_erased, image);
    const report = await createAvatarReport(h.db, h.ids.av_reporter, h.ids.av_erased, { reason: "other", note: "Evidence" });
    expect(report.ok).toBe(true);
    await h.db.update(reports).set({ status: "dismissed", handledAt: new Date() }).where(eq(reports.avatarUserId, h.ids.av_erased));
    expect((await loadAvatarReportCards(h.db, [h.ids.av_erased], true)).get(h.ids.av_erased)!.reports[0].url).toBe(saved.url);
    await deleteMedia(h.db, parseMediaPath(saved.url)!.id);
    expect((await loadAvatarReportCards(h.db, [h.ids.av_erased], true)).get(h.ids.av_erased)!.reports[0].url).toBeNull();
  });
  it("creates stable geometry without putting public member identifiers or text in image URLs", async () => {
    expect(avatarSvg(avatarSeed("person-one"))).toBe(avatarSvg(avatarSeed("person-one")));
    expect(avatarSvg(avatarSeed("person-one"))).not.toBe(avatarSvg(avatarSeed("person-two")));
    expect(avatarSvg(avatarSeed("person-one"))).not.toMatch(/<text|href=|script|foreignObject/);
    const [person] = await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.av_writer));
    const url = automaticAvatarUrl(person.publicId);
    expect(url).not.toContain(person.publicId);
    expect(url).not.toContain(person.userId);
    await h.db.update(profiles).set({ handle: "av_renamed", handleKey: "av_renamed" }).where(eq(profiles.userId, person.userId));
    expect((await loadMemberAvatars(h.db, ["av_renamed"])).get("av_renamed")).toBe(url);
  });

  it("serves same-origin SVGs with image headers, conditional reads and no membership oracle", async () => {
    const { loader } = await import("~/routes/avatar-file");
    const file = `${avatarSeed("synthetic-public-id")}.svg`;
    const request = h.request(`/avatars/${file}`, { as: "av_upload" });
    const result = await loader({ request, params: { file } });
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("image/svg+xml");
    expect(result.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(result.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(result.headers.get("content-security-policy")).toContain("sandbox");
    const conditional = h.request(`/avatars/${file}`, { as: "av_upload", headers: { "if-none-match": result.headers.get("etag")! } });
    expect((await loader({ request: conditional, params: { file } })).status).toBe(304);
    expect((await loader({ request, params: { file: "../../private.svg" } })).status).toBe(404);
    const previous = process.env.PUBLIC_READING;
    try {
      process.env.PUBLIC_READING = "";
      expect((await loader({ request: h.request(`/avatars/${file}`), params: { file } })).status).toBe(404);
      process.env.PUBLIC_READING = "1";
      expect((await loader({ request: h.request(`/avatars/${file}`), params: { file } })).status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_READING; else process.env.PUBLIC_READING = previous;
    }
  });

  it("crops, orients and rewrites images without embedded metadata, rejecting unsupported inputs", async () => {
    expect(image).toMatchObject({ width: AVATAR_EDGE, height: AVATAR_EDGE });
    const result = await sharp(image.bytes).metadata();
    expect(result.format).toBe("webp");
    for (const field of ["exif", "xmp", "icc", "iptc", "orientation"] as const) expect(result[field]).toBeUndefined();
    for (const format of ["png", "webp"] as const) {
      const input = await sharp(source).toFormat(format).toBuffer();
      expect(await rewriteMedia(input, { avatar: true })).toMatchObject({ width: AVATAR_EDGE, height: AVATAR_EDGE });
    }
    await expect(rewriteMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { avatar: true })).rejects.toMatchObject({ code: "type" });
  });

  it("uploads through the writer and CSRF gates, exports rewritten bytes and resets", async () => {
    const route = await import("~/routes/settings-avatar");
    const upload = (as: string, origin = BASE) => {
      const form = new FormData(); form.set("image", new File([new Uint8Array(source)], "camera.jpg", { type: "image/jpeg" }));
      const headers = h.request("/settings/avatar", { as }).headers; headers.set("origin", origin);
      return route.action({ request: new Request(`${BASE}/settings/avatar`, { method: "POST", headers, body: form }) });
    };
    expect(await h.outcome(() => upload("av_upload", "https://elsewhere.invalid"))).toMatchObject({ status: 403 });
    const result = await upload("av_upload"); expect(result.status).toBe(201);
    const saved = await result.json();
    const id = parseMediaPath(saved.url)!.id;
    expect(saved.uploaded).toBe(true);
    expect(await listOwnMedia(h.db, h.ids.av_upload)).toEqual([]);
    const exported = await buildMemberExport(h.db, h.ids.av_upload);
    expect(exported.version).toBe(MEMBER_EXPORT_VERSION);
    expect(exported.profile?.avatar).toMatchObject({ uploaded: true, mime: "image/webp" });
    expect(Buffer.from(exported.profile!.avatar.base64!, "base64")).toEqual(image.bytes);
    await h.db.update(profiles).set({ suspendedUntil: new Date("2090-01-01"), suspendedReason: "other" }).where(eq(profiles.userId, h.ids.av_upload));
    expect(await h.outcome(() => upload("av_upload"))).toMatchObject({ status: 302, location: "/suspended" });
    await h.db.update(profiles).set({ suspendedUntil: null }).where(eq(profiles.userId, h.ids.av_upload));
    const reset = await route.action({ request: h.request("/settings/avatar", { as: "av_upload", form: { intent: "reset" } }) });
    expect(await reset.json()).toMatchObject({ uploaded: false });
    expect(await exportMemberAvatar(h.db, h.ids.av_upload)).toEqual({ uploaded: false, mime: null, base64: null });
    expect(await h.db.select().from(media).where(eq(media.id, id))).toMatchObject([{ bytes: null }]);
  });

  it("serves active images publicly, withdraws replaced URLs and limits evidence to owner and operators", async () => {
    const first = await setMemberAvatar(h.db, h.ids.av_unreported, image);
    const firstId = parseMediaPath(first.url)!.id;
    expect(await canReadMedia(h.db, firstId, null)).toBe(true);
    const other = await rewriteMedia(await sharp(source).negate().png().toBuffer(), { avatar: true });
    const second = await setMemberAvatar(h.db, h.ids.av_unreported, other);
    expect(second.url).not.toBe(first.url);
    expect(await h.db.select().from(media).where(eq(media.id, firstId))).toMatchObject([{ bytes: null }]);
    await deleteMedia(h.db, parseMediaPath(second.url)!.id);
    expect((await loadMemberAvatars(h.db, ["av_unreported"])).get("av_unreported")).toMatch(/\.svg$/);
  });

  it("records reports, operator removal, notifications and an independent restoring appeal", async () => {
    const userId = h.ids.av_writer;
    const saved = await setMemberAvatar(h.db, userId, image), id = parseMediaPath(saved.url)!.id;
    const embedded = await createTopic(h.db, userId, { body: `![Avatar](${saved.url})`, lang: "en" });
    expect(embedded.ok).toBe(true);
    expect(await readMediaBatch(h.db, [id])).toHaveLength(1);
    expect(await createAvatarReport(h.db, userId, userId, { reason: "other" })).toMatchObject({ error: "own_entry" });
    const report = await createAvatarReport(h.db, h.ids.av_reporter, userId, { reason: "other", note: "Review this picture" });
    if (!report.ok) throw Error(report.error);
    expect(await createAvatarReport(h.db, h.ids.av_reporter, userId, { reason: "other" })).toMatchObject({ error: "duplicate" });
    expect((await listReportCards(h.db, { operator: false, langs: ["en"] })).cards.some(c => c.kind === "avatar")).toBe(false);
    const input = { userId, reportId: report.id, version: id, dismiss: false, reason: "other", note: "Removed after review" };
    expect(await moderateAvatar(h.db, { id: h.ids.av_operator, scope: { operator: false, langs: ["en"] } }, input)).toMatchObject({ error: "forbidden" });
    const removed = await moderateAvatar(h.db, actor(), input); if (!removed.ok) throw Error(removed.error);
    expect(await readMediaBatch(h.db, [id])).toEqual([]);
    expect(await canReadMedia(h.db, id, null)).toBe(false);
    expect(await canReadMedia(h.db, id, { userId: h.ids.av_reporter, scope: { operator: false, langs: [] } })).toBe(false);
    expect(await canReadMedia(h.db, id, { userId, scope: { operator: false, langs: [] } })).toBe(true);
    expect(await canReadMedia(h.db, id, { userId: h.ids.av_reviewer, scope })).toBe(true);
    expect(await h.db.select().from(notifications).where(eq(notifications.actionId, removed.actionId))).toMatchObject([{ userId, kind: "moderation" }]);
    expect(await getAppealableAction(h.db, h.ids.av_reporter, removed.actionId)).toBeNull();
    expect(await getAppealableAction(h.db, userId, removed.actionId)).toMatchObject({ avatarUrl: saved.url });
    const appeal = await createAppeal(h.db, userId, removed.actionId, "This is my picture"); if (!appeal.ok) throw Error(appeal.error);
    const decide = (name: string, operator = true) => decideAppeal(h.db, { id: h.ids[name], scope: { operator, langs: ["en"] } }, appeal.id, { decision: "overturned", note: "Allowed" });
    expect(await decide("av_operator")).toMatchObject({ error: "own_action" });
    expect(await decide("av_reporter")).toMatchObject({ error: "reporter" });
    expect(await decide("av_reviewer", false)).toMatchObject({ error: "forbidden" });
    expect((await listOpenAppeals(h.db, { id: h.ids.av_reviewer, scope: { operator: false, langs: ["en"] } })).cards).toEqual([]);
    expect(await decide("av_reviewer")).toMatchObject({ ok: true, reversed: true });
    expect(await canReadMedia(h.db, id, null)).toBe(true);
  });

  it("rejects forged own-media deletions and preserves avatar evidence through moderation and appeal", async () => {
    const userId = h.ids.av_evidence;
    const saved = await setMemberAvatar(h.db, userId, image), id = parseMediaPath(saved.url)!.id;
    const report = await createAvatarReport(h.db, h.ids.av_reporter, userId, { reason: "other" }); if (!report.ok) throw Error(report.error);
    const route = await import("~/routes/settings-media");
    const attempt = () => h.outcome(() => route.action(h.args(h.request("/settings/media", { as: "av_evidence", form: { id, confirm: "1", usage_count: "0" } }))));
    expect(await attempt()).toMatchObject({ status: 404 });
    expect(await h.db.select().from(media).where(eq(media.id, id))).toMatchObject([{ bytes: image.bytes, deletedAt: null }]);
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, userId))).toMatchObject([{ avatarMediaId: id }]);
    expect(await h.db.select().from(reports).where(eq(reports.id, report.id))).toMatchObject([{ avatarMediaId: id, status: "open" }]);
    const removed = await moderateAvatar(h.db, actor(), { userId, reportId: report.id, version: id, dismiss: false, reason: "other", note: "Review the image" }); if (!removed.ok) throw Error(removed.error);
    await h.db.update(profiles).set({ suspendedUntil: new Date("2090-01-01"), suspendedReason: "other" }).where(eq(profiles.userId, userId));
    expect(await attempt()).toMatchObject({ status: 404 });
    expect(await deleteOwnMedia(h.db, userId, id, 0)).toEqual({ status: "not_found" });
    expect(await getAppealableAction(h.db, userId, removed.actionId)).toMatchObject({ avatarUrl: saved.url });
    expect(await h.db.select().from(media).where(eq(media.id, id))).toMatchObject([{ bytes: image.bytes, deletedAt: null }]);
    expect(await h.db.select().from(moderationActions).where(eq(moderationActions.id, removed.actionId))).toMatchObject([{ avatarMediaIdBefore: id }]);
    const appeal = await createAppeal(h.db, userId, removed.actionId, "Please review the image"); if (!appeal.ok) throw Error(appeal.error);
    expect(await decideAppeal(h.db, actor("av_reviewer"), appeal.id, { decision: "overturned", note: "The image is allowed" })).toMatchObject({ ok: true, reversed: true });
    expect((await loadMemberAvatars(h.db, ["av_evidence"])).get("av_evidence")).toBe(saved.url);
  });

  it("rejects stale removal and preserves the member's later choice when an appeal succeeds", async () => {
    const userId = h.ids.av_changed;
    const first = await setMemberAvatar(h.db, userId, image), id = parseMediaPath(first.url)!.id;
    const report = await createAvatarReport(h.db, h.ids.av_reporter, userId, { reason: "other" }); if (!report.ok) throw Error(report.error);
    await setMemberAvatar(h.db, userId, null);
    const input = { userId, reportId: report.id, version: id, dismiss: false, reason: "other", note: "Review" };
    expect(await moderateAvatar(h.db, actor(), input)).toMatchObject({ error: "invalid_state" });
    await setMemberAvatar(h.db, userId, image);
    const removed = await moderateAvatar(h.db, actor(), input); if (!removed.ok) throw Error(removed.error);
    const appeal = await createAppeal(h.db, userId, removed.actionId, "Review"); if (!appeal.ok) throw Error(appeal.error);
    await setMemberAvatar(h.db, userId, null);
    expect(await decideAppeal(h.db, actor("av_reviewer"), appeal.id, { decision: "overturned", note: "Allowed" })).toMatchObject({ ok: true, reversed: false });
  });

  it("dismisses avatar reports without changing the image or notifying the member", async () => {
    const userId = h.ids.av_dismiss;
    const saved = await setMemberAvatar(h.db, userId, image);
    const report = await createAvatarReport(h.db, h.ids.av_reporter, userId, { reason: "other" }); if (!report.ok) throw Error(report.error);
    const result = await moderateAvatar(h.db, actor(), { userId, reportId: report.id, version: "", dismiss: true, reason: "other", note: "" }); if (!result.ok) throw Error(result.error);
    expect((await loadMemberAvatars(h.db, ["av_dismiss"])).get("av_dismiss")).toBe(saved.url);
    expect(await h.db.select().from(notifications).where(eq(notifications.actionId, result.actionId))).toEqual([]);
  });

  it("erases current and retained avatar images, reports and restoration pointers on account deletion", async () => {
    const userId = h.ids.av_departing;
    const saved = await setMemberAvatar(h.db, userId, image), id = parseMediaPath(saved.url)!.id;
    const report = await createAvatarReport(h.db, h.ids.av_reporter, userId, { reason: "other" }); if (!report.ok) throw Error(report.error);
    const removed = await moderateAvatar(h.db, actor(), { userId, reportId: report.id, version: id, dismiss: false, reason: "other", note: "Review" }); if (!removed.ok) throw Error(removed.error);
    await setMemberAvatar(h.db, userId, image);
    await deleteAccount(h.db, userId, { confirmation: "av_departing" });
    expect(await h.db.select().from(media).where(eq(media.id, id))).toMatchObject([{ bytes: null }]);
    expect(await h.db.select().from(moderationActions).where(eq(moderationActions.id, removed.actionId))).toMatchObject([{ avatarMediaIdBefore: null }]);
    expect(await h.db.select().from(reports).where(eq(reports.id, report.id))).toMatchObject([{ avatarMediaId: null }]);
  });
});
