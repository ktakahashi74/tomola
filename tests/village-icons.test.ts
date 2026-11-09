import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { PG_MODE } from "./helpers/pg-test";
import { setTestLocale } from "./stubs/paraglide-runtime";
import sharp from "sharp";
import { appeals, media, moderationActions, profiles, reports, villageMembers, villages } from "~/lib/db/schema";
import { LANGUAGE_ICON, VILLAGE_ICON, exportVillageIcons, setVillageIcon, villageIconUrl, withVillageIcons } from "~/lib/village-icon.server";
import { setMemberAvatar } from "~/lib/member-avatar.server";
import { rewriteMedia } from "~/lib/media-processing.server";
import { canReadMedia } from "~/lib/media-references.server";
import { deleteMedia, readMediaBatch } from "~/lib/media-store.server";
import { createVillageReport, loadVillageReportCards, moderateVillage, openVillageReportTargets, villageModerationVersion } from "~/lib/village-moderation.server";
import { createAppeal, decideAppeal, getAppealableAction } from "~/lib/appeals.server";
import { pruneIdentitySnapshots } from "~/lib/identity-retention.server";
import { deleteAccount } from "~/lib/account-delete.server";
import { buildMemberExport } from "~/lib/exports.server";
import { joinedVillageNavigation } from "~/lib/village-navigation.server";
import { followedVillageNavigation, setVillageFollow } from "~/lib/village-follows.server";
import { m } from "~/paraglide/messages.js";
import { FOLLOWED_NAVIGATION_VISIBLE } from "~/lib/village-follow-limits";
import { parseMediaPath } from "~/lib/media";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

let h: RouteHarness;
let image: Awaited<ReturnType<typeof rewriteMedia>>;
let source: Buffer;
const op = (name = "vi_operator") => ({ id: h.ids[name], scope: { operator: true, langs: [] } });
async function place(slug: string, owner = "vi_owner") {
  const [row] = await h.db.insert(villages).values({ slug, kind: "open", name: slug }).returning();
  await h.db.insert(villageMembers).values([{ villageId: row.id, userId: h.ids[owner], role: "owner" }, { villageId: row.id, userId: h.ids.vi_coowner, role: "owner" }]);
  return row;
}
const savedId = (url: string) => parseMediaPath(url)!.id;
const savedPlace = async (id: string) => (await h.db.select().from(villages).where(eq(villages.id, id)))[0];
async function report(slug: string) {
  const result = await createVillageReport(h.db, h.ids.vi_outsider, { slug, reason: "other", target: "icon" });
  if (!result.ok) throw Error(result.error);
  return result.id;
}
async function clear(id: string, reportId?: number) {
  const row = await savedPlace(id);
  const result = await moderateVillage(h.db, op(), { ...(reportId ? { reportId } : { slugTarget: row.slug! }), version: await villageModerationVersion(h.db, id), intent: "clear-icon", reason: "other", note: "Review the village image" });
  if (!result.ok) throw Error(result.error);
  return result.actionId;
}
beforeAll(async () => {
  vi.stubEnv("VILLAGES", "1");
  h = await setupRouteHarness();
  for (const name of ["vi_owner", "vi_coowner", "vi_outsider", "vi_operator", "vi_reviewer", "vi_departing"]) await h.signIn(name, { homeArea: "en" });
  source = await sharp({ create: { width: 40, height: 70, channels: 3, background: "#789" } }).withExif({ IFD0: { Artist: "Private camera" } }).jpeg().toBuffer();
  image = await rewriteMedia(source, { avatar: true });
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });

describe("village icons", () => {
  it("uses member images for personal places, one language symbol, and a shared fallback", async () => {
    const [person] = await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.vi_owner));
    expect(villageIconUrl({ kind: "personal", ...person })).toMatch(/^\/avatars\//);
    const portrait = await setMemberAvatar(h.db, person.userId, image);
    const village = await place("icons-kind");
    const saved = await setVillageIcon(h.db, person.userId, village.slug!, image);
    expect(saved.url).not.toBe(portrait.url);
    const rows = await withVillageIcons(h.db, [{ slug: "@vi_owner", kind: "personal" }, { slug: village.slug, kind: "open" }]);
    expect(rows.map(row => row.iconUrl)).toEqual([portrait.url, saved.url]);
    expect(villageIconUrl({ kind: "open", language: "ja", iconMediaId: savedId(saved.url) })).toBe(LANGUAGE_ICON);
    expect(villageIconUrl({ kind: "open", language: "en" })).toBe(LANGUAGE_ICON);
    expect(villageIconUrl({ kind: "open" })).toBe(VILLAGE_ICON);
    expect(decodeURIComponent(VILLAGE_ICON)).not.toMatch(/<text|script|foreignObject/);
    await expect(setVillageIcon(h.db, person.userId, "en", image)).rejects.toMatchObject({ status: 404 });
    await expect(setVillageIcon(h.db, person.userId, "@vi_owner", image)).rejects.toMatchObject({ status: 404 });
  });

  it("sends the overflow label in the screen language, independently of the reading language", async () => {
    const handle = "vi_more"; await h.signIn(handle, { homeArea: "en" });
    const rows = await h.db.insert(villages).values(Array.from({ length: FOLLOWED_NAVIGATION_VISIBLE + 2 }, (_, i) => ({ slug: `icons-more-${i}`, kind: "open", name: `Place ${i}` }))).returning();
    for (const row of rows) await setVillageFollow(h.db, h.ids[handle], row.slug!, true);
    try {
      for (const locale of ["en", "ja"] as const) {
        setTestLocale(locale);
        const reading = locale === "en" ? "ja" : "en";
        const navigation = await followedVillageNavigation(h.db, h.ids[handle], { displayLang: reading, readLangs: [reading] });
        expect(navigation[0].moreLabel).toBe(m.village_follow_more({ count: 2 }, { locale }));
        expect(navigation.every(row => row.iconUrl === VILLAGE_ICON)).toBe(true);
        expect(navigation.slice(1).every(row => row.moreLabel === undefined)).toBe(true);
      }
    } finally { setTestLocale("en"); }
  });

  it("reuses the upload gates and image rewriting, and allows either owner to replace or reset", async () => {
    const row = await place("icons-upload");
    const route = await import("~/routes/village-icon");
    const upload = (as: string, origin = BASE) => {
      const form = new FormData(); form.set("image", new File([new Uint8Array(source)], "camera.jpg", { type: "image/jpeg" }));
      const headers = h.request(`/v/${row.slug}/icon`, { as }).headers; headers.set("origin", origin);
      return route.action({ request: new Request(`${BASE}/v/${row.slug}/icon`, { method: "POST", headers, body: form }), params: { slug: row.slug! } });
    };
    expect(await h.outcome(() => upload("vi_owner", "https://elsewhere.invalid"))).toMatchObject({ status: 403 });
    expect((await upload("vi_outsider")).status).toBe(403);
    const uploaded = await upload("vi_owner"); expect(uploaded.status).toBe(201);
    const saved = await uploaded.json();
    const [bytes] = await h.db.select().from(media).where(eq(media.id, savedId(saved.url)));
    const meta = await sharp(bytes.bytes!).metadata();
    expect(meta).toMatchObject({ width: 256, height: 256, format: "webp" });
    for (const key of ["exif", "xmp", "icc", "iptc", "orientation"] as const) expect(meta[key]).toBeUndefined();
    expect((await buildMemberExport(h.db, h.ids.vi_coowner)).village_icons).toContainEqual({ village: row.slug, mime: "image/webp", base64: image.bytes.toString("base64") });
    await expect(setVillageIcon(h.db, h.ids.vi_outsider, row.slug!, null)).rejects.toMatchObject({ status: 403 });
    const reset = await setVillageIcon(h.db, h.ids.vi_coowner, row.slug!, null);
    expect(reset).toEqual({ uploaded: false, url: VILLAGE_ICON });
    expect((await h.db.select().from(media).where(eq(media.id, bytes.id)))[0].bytes).toBeNull();
  });

  it("withdraws closed village images and keeps them out of navigation and public exports", async () => {
    const row = await place("icons-closed");
    const saved = await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image), id = savedId(saved.url);
    expect(await canReadMedia(h.db, id, null)).toBe(true);
    process.env.VILLAGES = "";
    expect(await canReadMedia(h.db, id, null)).toBe(false);
    expect(await canReadMedia(h.db, id, { userId: h.ids.vi_operator, scope: op().scope })).toBe(true);
    process.env.VILLAGES = "1";
    expect(await readMediaBatch(h.db, [id])).toEqual([]);
    await h.db.update(villages).set({ kind: "closed" }).where(eq(villages.id, row.id));
    expect(await canReadMedia(h.db, id, null)).toBe(false);
    expect(await canReadMedia(h.db, id, { userId: h.ids.vi_operator, scope: op().scope })).toBe(false);
    expect((await joinedVillageNavigation(h.db, h.ids.vi_owner)).some(v => v.slug === row.slug)).toBe(false);
    await expect(setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image)).rejects.toMatchObject({ status: 404 });
    const { loader } = await import("~/routes/media-file");
    expect((await loader({ request: h.request(saved.url, { as: "vi_outsider" }) })).status).toBe(404);
  });

  it("captures report evidence, removes the live icon, and restores it on an independent appeal", async () => {
    const row = await place("icons-appeal");
    const saved = await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image), id = savedId(saved.url);
    const reportId = await report(row.slug!);
    const actionId = await clear(row.id, reportId);
    expect(villageIconUrl(await savedPlace(row.id))).toBe(VILLAGE_ICON);
    expect(await canReadMedia(h.db, id, null)).toBe(false);
    expect((await loadVillageReportCards(h.db, [row.id], true)).get(row.id)?.reports[0].iconUrl).toBe(saved.url);
    expect(await getAppealableAction(h.db, h.ids.vi_owner, actionId)).toMatchObject({ avatarUrl: saved.url });
    expect(await getAppealableAction(h.db, h.ids.vi_outsider, actionId)).toBeNull();
    const appeal = await createAppeal(h.db, h.ids.vi_coowner, actionId, "Please review the icon"); if (!appeal.ok) throw Error(appeal.error);
    await h.db.delete(villageMembers).where(and(eq(villageMembers.villageId, row.id), eq(villageMembers.userId, h.ids.vi_coowner)));
    expect(await canReadMedia(h.db, id, { userId: h.ids.vi_coowner, scope: { operator: false, langs: [] } })).toBe(true);
    expect(await canReadMedia(h.db, id, { userId: h.ids.vi_outsider, scope: { operator: false, langs: [] } })).toBe(false);
    expect(await decideAppeal(h.db, op(), appeal.id, { decision: "overturned", note: "Allowed" })).toMatchObject({ error: "own_action" });
    expect(await decideAppeal(h.db, op("vi_outsider"), appeal.id, { decision: "overturned", note: "Allowed" })).toMatchObject({ error: "reporter" });
    expect(await decideAppeal(h.db, op("vi_reviewer"), appeal.id, { decision: "overturned", note: "Allowed" })).toMatchObject({ ok: true, reversed: true });
    expect(villageIconUrl(await savedPlace(row.id))).toBe(saved.url);
  });

  it.each(["information", "icon"] as const)("records separate report targets for one reporter (%s first)", async first => {
    const row = await place(`icons-report-${first}`);
    const saved = await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image);
    const targets = [first, first === "icon" ? "information" : "icon"] as const;
    for (const target of targets) {
      const input = { slug: row.slug!, reason: "other", target };
      expect(await createVillageReport(h.db, h.ids.vi_outsider, input)).toMatchObject({ ok: true });
      expect(await createVillageReport(h.db, h.ids.vi_outsider, input)).toEqual({ ok: false, error: "duplicate" });
    }
    const savedReports = await h.db.select().from(reports).where(eq(reports.villageId, row.id));
    expect(savedReports).toHaveLength(2);
    expect(savedReports.find(r => r.villageTarget === "information")).toMatchObject({ iconMediaId: null });
    expect(savedReports.find(r => r.villageTarget === "icon")).toMatchObject({ iconMediaId: savedId(saved.url) });
    expect((await openVillageReportTargets(h.db, row.id, h.ids.vi_outsider)).sort()).toEqual(["icon", "information"]);
    let card = (await loadVillageReportCards(h.db, [row.id], false)).get(row.id)!;
    expect(card.reports.find(r => r.target === "information")).toMatchObject({ iconUrl: null });
    expect(card.reports.find(r => r.target === "icon")).toMatchObject({ iconUrl: saved.url });
    await deleteMedia(h.db, savedId(saved.url));
    card = (await loadVillageReportCards(h.db, [row.id], false)).get(row.id)!;
    expect(card.reports.map(r => r.target)).toEqual(targets);
    expect(card.reports.every(r => r.iconUrl === null)).toBe(true);
    expect(await createVillageReport(h.db, h.ids.vi_outsider, { slug: row.slug!, reason: "other" })).toMatchObject({ error: "duplicate" });
  });

  it("does not preserve image evidence for an information report and rejects unavailable or invalid targets", async () => {
    const row = await place("icons-information-only");
    expect(await createVillageReport(h.db, h.ids.vi_outsider, { slug: row.slug!, reason: "other", target: "icon" })).toMatchObject({ error: "not_found" });
    const saved = await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image);
    expect(await createVillageReport(h.db, h.ids.vi_outsider, { slug: row.slug!, reason: "other", target: "unknown" })).toMatchObject({ error: "invalid_state" });
    expect(await h.db.select().from(reports).where(eq(reports.villageId, row.id))).toEqual([]);
    expect(await createVillageReport(h.db, h.ids.vi_outsider, { slug: row.slug!, reason: "other" })).toMatchObject({ ok: true });
    expect(await openVillageReportTargets(h.db, row.id, h.ids.vi_outsider)).toEqual(["information"]);
    await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, null);
    expect((await h.db.select().from(media).where(eq(media.id, savedId(saved.url))))[0].bytes).toBeNull();
  });

  it("rejects stale moderation and does not overwrite a later owner choice on appeal", async () => {
    const row = await place("icons-changed");
    await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image);
    const version = await villageModerationVersion(h.db, row.id);
    await setVillageIcon(h.db, h.ids.vi_coowner, row.slug!, null);
    expect(await moderateVillage(h.db, op(), { slugTarget: row.slug!, version, intent: "clear-icon", reason: "other", note: "Stale" })).toMatchObject({ error: "stale" });
    await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image);
    const reportId = await report(row.slug!), actionId = await clear(row.id, reportId);
    const appeal = await createAppeal(h.db, h.ids.vi_owner, actionId, "Review"); if (!appeal.ok) throw Error(appeal.error);
    await setVillageIcon(h.db, h.ids.vi_coowner, row.slug!, null);
    expect(await decideAppeal(h.db, op("vi_reviewer"), appeal.id, { decision: "overturned", note: "Allowed" })).toMatchObject({ ok: true, reversed: false });
  });

  it("retains evidence through an open appeal and expires it 180 days after its decision", async () => {
    const row = await place("icons-retention");
    const saved = await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image), id = savedId(saved.url);
    const reportId = await report(row.slug!), actionId = await clear(row.id, reportId);
    const old = new Date("2030-01-01"), now = new Date("2031-01-01");
    await h.db.update(media).set({ uploadedAt: old }).where(eq(media.id, id));
    await h.db.update(reports).set({ handledAt: old }).where(eq(reports.id, reportId));
    await h.db.update(moderationActions).set({ createdAt: old }).where(eq(moderationActions.id, actionId));
    const appeal = await createAppeal(h.db, h.ids.vi_owner, actionId, "Review", { now: old }); if (!appeal.ok) throw Error(appeal.error);
    await pruneIdentitySnapshots(h.db, now);
    expect((await h.db.select().from(media).where(eq(media.id, id)))[0].bytes).not.toBeNull();
    await h.db.update(appeals).set({ status: "upheld", decidedAt: now }).where(eq(appeals.id, appeal.id));
    const unrelated = await moderateVillage(h.db, op(), { slugTarget: row.slug!, version: await villageModerationVersion(h.db, row.id), intent: "end", reason: "other", note: "A separate closure" }, { now });
    if (!unrelated.ok) throw Error(unrelated.error);
    expect(await createAppeal(h.db, h.ids.vi_owner, unrelated.actionId, "Review the closure", { now })).toMatchObject({ ok: true });
    await pruneIdentitySnapshots(h.db, new Date(now.getTime() + 180 * 86400_000));
    expect((await h.db.select().from(media).where(eq(media.id, id)))[0].bytes).not.toBeNull();
    await pruneIdentitySnapshots(h.db, new Date(now.getTime() + 180 * 86400_000 + 1));
    expect((await h.db.select().from(media).where(eq(media.id, id)))[0].bytes).toBeNull();
    expect((await h.db.select().from(reports).where(eq(reports.id, reportId)))[0]).toMatchObject({ iconMediaId: null, villageTarget: "icon" });
  });

  it("clears current pointers on media deletion and removes village images with the village", async () => {
    const row = await place("icons-deleted");
    const saved = await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image);
    await deleteMedia(h.db, savedId(saved.url));
    expect(villageIconUrl(await savedPlace(row.id))).toBe(VILLAGE_ICON);
    const next = await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image);
    expect(next.url).not.toBe(saved.url);
    await h.db.delete(villages).where(eq(villages.id, row.id));
    expect(await h.db.select().from(media).where(eq(media.id, savedId(next.url)))).toEqual([]);
  });

  it("erases a departing uploader's live and evidence images immediately", async () => {
    const row = await place("icons-departing", "vi_departing");
    const saved = await setVillageIcon(h.db, h.ids.vi_departing, row.slug!, image), id = savedId(saved.url);
    const reportId = await report(row.slug!), actionId = await clear(row.id, reportId);
    const appeal = await createAppeal(h.db, h.ids.vi_departing, actionId, "Review"); expect(appeal.ok).toBe(true);
    await deleteAccount(h.db, h.ids.vi_departing, { confirmation: "vi_departing", posts: "keep" });
    expect((await h.db.select().from(media).where(eq(media.id, id)))[0].bytes).toBeNull();
    expect((await h.db.select().from(reports).where(eq(reports.id, reportId)))[0].iconMediaId).toBeNull();
    expect((await h.db.select().from(moderationActions).where(eq(moderationActions.id, actionId)))[0].iconMediaIdBefore).toBeNull();
    expect(await exportVillageIcons(h.db, h.ids.vi_coowner)).not.toContainEqual(expect.objectContaining({ village: row.slug }));
  });
});


it.skipIf(!PG_MODE)("keeps concurrent reports unique per village target on PostgreSQL", { tags: ["postgres"] }, async () => {
  const row = await place("icons-report-race");
  await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image);
  const results = await Promise.all((["information", "icon", "information", "icon"] as const).map(target =>
    createVillageReport(h.db, h.ids.vi_outsider, { slug: row.slug!, reason: "other", target })));
  expect(results.filter(r => r.ok)).toHaveLength(2);
  expect(results.filter(r => !r.ok)).toEqual([{ ok: false, error: "duplicate" }, { ok: false, error: "duplicate" }]);
  expect((await openVillageReportTargets(h.db, row.id, h.ids.vi_outsider)).sort()).toEqual(["icon", "information"]);
});

it.skipIf(!PG_MODE).each(["owner-first", "moderation-first"])("serializes icon reset and moderation on PostgreSQL (%s)", { tags: ["postgres"] }, async order => {
  const row = await place(`icons-race-${order}`);
  await setVillageIcon(h.db, h.ids.vi_owner, row.slug!, image);
  const reportId = await report(row.slug!);
  const version = await villageModerationVersion(h.db, row.id);
  const reset = (db: typeof h.db) => setVillageIcon(db, h.ids.vi_coowner, row.slug!, null);
  const remove = (db: typeof h.db) => moderateVillage(db, op(), { reportId, version, intent: "clear-icon", reason: "other", note: "Review" });
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = h.db.transaction(async tx => {
    const result = await (order === "owner-first" ? reset(tx) : remove(tx));
    expect(result).not.toHaveProperty("error"); entered(); await gate;
  });
  await inside;
  const queued = Promise.allSettled([order === "owner-first" ? remove(h.db) : reset(h.db)]);
  try {
    await expect.poll(async () => {
      const result = await h.db.execute(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`);
      return (result as unknown as { rows: { waiting: number }[] }).rows[0].waiting;
    }).toBeGreaterThan(0);
  } finally { release(); }
  await first;
  expect(await queued).toMatchObject([{ status: "fulfilled", value: order === "owner-first" ? { ok: false, error: "stale" } : { uploaded: false } }]);
  expect(await savedPlace(row.id)).toMatchObject({ iconMediaId: null, iconActionId: null });
});
