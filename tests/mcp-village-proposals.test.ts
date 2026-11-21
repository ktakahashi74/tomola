import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { and, count, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { deleteAccount } from "~/lib/account-delete.server";
import { media, villageEvents, villageMembers, villageProposals, villages } from "~/lib/db/schema";
import { buildMemberExport } from "~/lib/exports.server";
import {
  applyVillageProposal, createVillageProposal, discardClientVillageProposal, getClientVillageProposal,
  pruneVillageProposals, readVillageProposalReview, villageProposalPath,
} from "~/lib/mcp/village-proposals.server";
import { MEDIA_LIMITS, mediaPath, parseMediaPath } from "~/lib/media";
import { deleteMedia, putMedia } from "~/lib/media-store.server";
import { changeVillageMembership } from "~/lib/villages.server";
import { VILLAGE_ICON } from "~/lib/village-icon.server";
import { editVillage, endVillage } from "~/lib/village-management.server";
import { action, loader } from "~/routes/village-proposal";
import { loader as mediaFile } from "~/routes/media-file";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
let image: { bytes: Buffer; width: number; height: number };
const client = { key: "oauth:editor", id: "editor", name: "Editor", uri: null, tokenId: null };
const otherClient = { ...client, key: "oauth:other", id: "other" };
const owner = () => h.ids.proposal_owner;
const coowner = () => h.ids.proposal_coowner;
const other = () => h.ids.proposal_other;

beforeAll(async () => {
  vi.stubEnv("VILLAGES", "1");
  vi.stubEnv("PUBLIC_READING", "1");
  h = await setupRouteHarness();
  for (const name of ["proposal_owner", "proposal_coowner", "proposal_other"]) await h.signIn(name, { homeArea: "en" });
  const width = 40, height = 70;
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#789" } }).webp().toBuffer();
  image = { bytes, width, height };
});
afterEach(async () => { await h.db.delete(villageProposals); });
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });

async function addVillage(slug: string) {
  const [village] = await h.db.insert(villages).values({ slug, kind: "open", name: "Old name", description: "Original description", sourceLang: "en" }).returning();
  await h.db.insert(villageMembers).values([owner(), coowner()].map(userId => ({ villageId: village.id, userId, role: "owner" })));
  return village;
}
async function propose(input: Parameters<typeof createVillageProposal>[3]) {
  const result = await createVillageProposal(h.db, owner(), client, input);
  if (!result.ok) throw new Error(result.error);
  return result.proposal;
}
const villageRow = async (slug: string) => (await h.db.select().from(villages).where(eq(villages.slug, slug)))[0];

it("keeps the proposal private to its member and client and applies only a current same-origin browser confirmation", async () => {
  const slug = "proposal-text";
  const village = await addVillage(slug);
  const proposal = await propose({ slug, name: "New name", description: "Updated description" });
  const { id, version } = proposal;
  const path = villageProposalPath(id);
  const load = (as?: string) => h.outcome(() => loader(h.args(h.request(path, { as }), { id })));
  const apply = (as: string, value = version, origin?: string) => h.outcome(() => action(h.args(h.request(path, {
    as, form: { version: value, intent: "apply" }, headers: origin ? { origin } : undefined,
  }), { id })));
  expect(await getClientVillageProposal(h.db, owner(), client, id)).toEqual({ ok: true, proposal });
  for (const [userId, identity] of [[owner(), otherClient], [coowner(), client]] as const) {
    expect(await getClientVillageProposal(h.db, userId, identity, id)).toEqual({ ok: false, error: "not_found" });
    expect(await discardClientVillageProposal(h.db, userId, identity, id)).toBe(false);
  }
  expect(await load()).toMatchObject({ status: 302 });
  expect(await load("proposal_coowner")).toMatchObject({ status: 404 });
  expect(await load("proposal_owner")).toMatchObject({ status: 200, value: { init: { headers: { "Cache-Control": "private, no-store" } }, data: { review: {
    version, before: { name: "Old name", description: "Original description" }, after: { name: "New name", description: "Updated description" },
  } } } });
  expect(await apply("proposal_coowner")).toMatchObject({ status: 404 });
  expect(await apply("proposal_owner", version, "https://elsewhere.invalid")).toMatchObject({ status: 403 });
  expect(await apply("proposal_owner", "0".repeat(64))).toMatchObject({ status: 409 });
  expect(await villageRow(slug)).toMatchObject({ name: "Old name", description: "Original description" });
  expect(await apply("proposal_owner")).toMatchObject({ status: 303, location: `/v/${slug}` });
  expect(await villageRow(slug)).toMatchObject({ name: "New name", description: "Updated description", sourceLang: "en" });
  expect(await h.db.select().from(villageEvents).where(eq(villageEvents.villageId, village.id))).toMatchObject([
    { actorId: owner(), action: "edit", detail: { oldName: "Old name", name: "New name" } },
  ]);
  expect(await apply("proposal_owner")).toMatchObject({ status: 404 });
});

it("keeps the rewritten icon in the submitter's private preview and publishes a separate icon only on approval", async () => {
  const slug = "proposal-icon";
  const village = await addVillage(slug);
  const foreign = await putMedia(h.db, other(), image);
  expect(await createVillageProposal(h.db, owner(), client, { slug, icon: { action: "replace", mediaId: parseMediaPath(foreign.url)!.id } }))
    .toEqual({ ok: false, error: "invalid_image" });
  const stored = await putMedia(h.db, owner(), image);
  const mediaId = parseMediaPath(stored.url)!.id;
  const { id, version } = await propose({ slug, icon: { action: "replace", mediaId } });
  const path = villageProposalPath(id);
  const outsider = h.request(path, { as: "proposal_coowner" });
  expect(await h.outcome(() => loader(h.args(outsider, { id })))).toMatchObject({ status: 404 });
  expect(await h.db.select().from(media).where(eq(media.villageId, village.id))).toEqual([]);
  expect((await mediaFile({ request: h.request(stored.url) })).status).toBe(404);
  expect(await getClientVillageProposal(h.db, owner(), client, id)).toMatchObject({ ok: true, proposal: { icon: "replace" } });
  const exported = await buildMemberExport(h.db, owner());
  expect(exported.village_proposals).toMatchObject([{ id, village: slug, icon: { mime: "image/webp" } }]);
  expect((await buildMemberExport(h.db, coowner())).village_proposals).toEqual([]);
  const review = await readVillageProposalReview(h.db, owner(), id);
  if (!review.ok) throw new Error(review.error);
  expect(review.before.icon).toBe(VILLAGE_ICON);
  const candidate = review.after.icon!.split(",")[1];
  expect(candidate).toBe(exported.village_proposals[0].icon?.base64);
  const normalized = await sharp(Buffer.from(candidate, "base64")).metadata();
  expect(normalized).toMatchObject({ width: 256, height: 256, format: "webp" });
  expect(normalized.exif).toBeUndefined();
  expect(await applyVillageProposal(h.db, owner(), id, version)).toEqual({ ok: true, village: slug });
  const [icon] = await h.db.select().from(media).where(eq(media.villageId, village.id));
  expect(icon.id).not.toBe(mediaId);
  expect(icon.bytes?.toString("base64")).toBe(candidate);
  expect((await mediaFile({ request: h.request(mediaPath(icon.id, icon.width, icon.height)) })).status).toBe(200);
  expect((await mediaFile({ request: h.request(stored.url) })).status).toBe(404);
  expect(await readVillageProposalReview(h.db, owner(), id)).toEqual({ ok: false, error: "not_found" });
  const reset = await propose({ slug, icon: { action: "reset" } });
  expect(await readVillageProposalReview(h.db, owner(), reset.id)).toMatchObject({ ok: true, after: { icon: VILLAGE_ICON } });
  expect(await applyVillageProposal(h.db, owner(), reset.id, reset.version)).toMatchObject({ ok: true });
  expect(await villageRow(slug)).toMatchObject({ iconMediaId: null });
  const snapshot = await propose({ slug, icon: { action: "replace", mediaId } });
  expect(await deleteMedia(h.db, mediaId)).toBe(true);
  expect(await createVillageProposal(h.db, owner(), client, { slug, icon: { action: "replace", mediaId } }))
    .toEqual({ ok: false, error: "invalid_image" });
  expect(await readVillageProposalReview(h.db, owner(), snapshot.id)).toMatchObject({ ok: true, after: { icon: `data:image/webp;base64,${candidate}` } });
  const discard = h.request(villageProposalPath(snapshot.id), { as: "proposal_owner", form: { version: snapshot.version, intent: "discard" } });
  expect(await h.outcome(() => action(h.args(discard, { id: snapshot.id })))).toMatchObject({ status: 303, location: `/v/${slug}` });
  expect(await readVillageProposalReview(h.db, owner(), snapshot.id)).toEqual({ ok: false, error: "not_found" });
  expect((await buildMemberExport(h.db, owner())).village_proposals).toEqual([]);
});

it("rejects a stale base or a departed owner and allows text proposals for an ended village", async () => {
  const slug = "proposal-stale";
  await addVillage(slug);
  const original = await propose({ slug, name: "Proposal" });
  expect(await editVillage(h.db, coowner(), slug, { name: "Old name", description: "Original description", sourceLang: "ja" })).toMatchObject({ ok: true });
  expect(await getClientVillageProposal(h.db, owner(), client, original.id)).toMatchObject({ ok: true, proposal: { status: "stale" } });
  expect(await editVillage(h.db, coowner(), slug, { name: "Old name", description: "Original description", sourceLang: "en" })).toMatchObject({ ok: true });
  expect(await applyVillageProposal(h.db, owner(), original.id, original.version)).toEqual({ ok: false, error: "stale" });
  const path = villageProposalPath(original.id);
  const discard = h.request(path, { as: "proposal_owner", form: { version: original.version, intent: "discard" } });
  expect(await h.outcome(() => action(h.args(discard, { id: original.id })))).toMatchObject({ status: 303, location: `/v/${slug}` });
  expect(await endVillage(h.db, coowner(), slug)).toMatchObject({ ok: true });
  expect(await createVillageProposal(h.db, owner(), client, { slug, name: "Other", icon: { action: "reset" } })).toEqual({ ok: false, error: "not_found" });
  const second = await propose({ slug, description: "" });
  expect(await readVillageProposalReview(h.db, owner(), second.id)).toMatchObject({ ok: true, after: { description: "" } });
  expect(await changeVillageMembership(h.db, owner(), slug, "leave")).toBe(true);
  expect(await readVillageProposalReview(h.db, owner(), second.id)).toEqual({ ok: false, error: "not_found" });
  expect(await applyVillageProposal(h.db, owner(), second.id, second.version)).toEqual({ ok: false, error: "not_found" });
  expect(await discardClientVillageProposal(h.db, owner(), client, second.id)).toBe(true);
});

it("rolls back a text edit if storing the candidate icon would exceed the member quota", async () => {
  const slug = "proposal-rollback";
  const village = await addVillage(slug);
  const stored = await putMedia(h.db, owner(), image);
  const proposal = await propose({ slug, name: "Proposed name", icon: { action: "replace", mediaId: parseMediaPath(stored.url)!.id } });
  const fill = Array.from({ length: MEDIA_LIMITS.storedCount }, (_, i) => ({ id: i.toString(16).padStart(64, "0"), bytes: image.bytes,
    mime: "image/webp", width: image.width, height: image.height, byteSize: image.bytes.length, uploadedBy: owner() }));
  await h.db.insert(media).values(fill);
  try {
    expect(await applyVillageProposal(h.db, owner(), proposal.id, proposal.version)).toEqual({ ok: false, error: "image_limit" });
    expect(await villageRow(slug)).toMatchObject({ name: "Old name", iconMediaId: null });
    expect(await getClientVillageProposal(h.db, owner(), client, proposal.id)).toMatchObject({ ok: true, proposal: { status: "pending" } });
    expect(await h.db.select().from(villageEvents).where(eq(villageEvents.villageId, village.id))).toEqual([]);
  } finally {
    await h.db.delete(media).where(and(inArray(media.id, fill.map(row => row.id)), eq(media.uploadedBy, owner())));
  }
});

it("consumes a proposal once when approvals race", async () => {
  const slug = "proposal-race";
  const village = await addVillage(slug);
  const { id, version } = await propose({ slug, name: "Approved once" });
  const results = await Promise.all([0, 1].map(() => applyVillageProposal(h.db, owner(), id, version)));
  expect(results).toContainEqual({ ok: true, village: slug });
  expect(results).toContainEqual({ ok: false, error: "not_found" });
  expect(await h.db.select({ n: count() }).from(villageEvents).where(eq(villageEvents.villageId, village.id))).toEqual([{ n: 1 }]);
});

it("serializes disposal of the proposal against applying it", async () => {
  const slug = "proposal-discard-race";
  const village = await addVillage(slug);
  const { id, version } = await propose({ slug, name: "Apply or discard" });
  const [applied, discarded] = await Promise.all([
    applyVillageProposal(h.db, owner(), id, version), discardClientVillageProposal(h.db, owner(), client, id),
  ]);
  expect(applied.ok).toBe(!discarded);
  expect(await h.db.select({ n: count() }).from(villageEvents).where(eq(villageEvents.villageId, village.id))).toEqual([{ n: discarded ? 0 : 1 }]);
  expect(await getClientVillageProposal(h.db, owner(), client, id)).toEqual({ ok: false, error: "not_found" });
});

it("caps pending proposals per member across clients, excludes expired proposals and physically removes them", async () => {
  const slug = "proposal-expiry";
  await addVillage(slug);
  const first = await propose({ slug, description: "First proposal" });
  for (let i = 1; i < 10; i++) await propose({ slug, description: `Proposal ${i}` });
  expect(await createVillageProposal(h.db, owner(), otherClient, { slug, description: "Over the cap" })).toEqual({ ok: false, error: "limit" });
  const now = new Date();
  await h.db.update(villageProposals).set({ expiresAt: now, createdAt: new Date(now.getTime() - 1000) }).where(eq(villageProposals.id, first.id));
  expect(await getClientVillageProposal(h.db, owner(), client, first.id)).toEqual({ ok: false, error: "not_found" });
  expect(await applyVillageProposal(h.db, owner(), first.id, first.version)).toEqual({ ok: false, error: "not_found" });
  expect(await pruneVillageProposals(h.db, now)).toBe(1);
  expect(await createVillageProposal(h.db, owner(), otherClient, { slug, description: "In the available slot" })).toMatchObject({ ok: true });
});

it("erases a departing owner's proposal and candidate without deleting the co-owned village", async () => {
  await h.signIn("proposal_departing", { homeArea: "en" });
  const departing = h.ids.proposal_departing;
  const slug = "proposal-departing";
  const village = await addVillage(slug);
  await h.db.insert(villageMembers).values({ villageId: village.id, userId: departing, role: "owner" });
  const stored = await putMedia(h.db, departing, image);
  const result = await createVillageProposal(h.db, departing, client, { slug, icon: { action: "replace", mediaId: parseMediaPath(stored.url)!.id } });
  if (!result.ok) throw new Error(result.error);
  await deleteAccount(h.db, departing, { confirmation: "proposal_departing", posts: "keep" });
  expect(await h.db.select().from(villageProposals).where(eq(villageProposals.id, result.proposal.id))).toEqual([]);
  expect(await villageRow(slug)).toMatchObject({ id: village.id, iconMediaId: null });
});
