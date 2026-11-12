import { afterEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { notifications, profiles, user, villageInvites, villageMembers, villages } from "~/lib/db/schema";
import { changeVillageMembership, ensureLanguageVillages, villageBySlug } from "~/lib/villages.server";
import { cancelVillageInvite, createVillage, editVillage, incomingVillageInvites, inviteToVillage, removeVillageMember, respondToVillageInvite, villageManagement } from "~/lib/village-management.server";
import { validVillageSlug, VILLAGE_INVITE_DAILY_LIMIT, VILLAGE_REINVITE_HOURS, VILLAGE_ROSTER_PAGE_SIZE } from "~/lib/villages";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
  const db = await createTestDb(); await ensureLanguageVillages(db);
  for (const name of ["owner", "guest", "second"]) await addMember(db, name, `vm_${name}`, { homeArea: "en" });
  await createVillage(db, "owner", { slug: "club", name: "Club", description: "", kind: "invite_public" });
  return { db, village: (await villageBySlug(db, "club"))! };
}
async function pending(db: Awaited<ReturnType<typeof world>>["db"], userId = "guest") {
  const [row] = await db.select().from(villageInvites).where(and(eq(villageInvites.userId, userId), eq(villageInvites.state, "pending")));
  return row.id;
}

it("counts both invitation kinds and cancelled invitations in a sender's rolling day", async () => {
  const { db, village } = await world(), now = new Date();
  await db.insert(villageMembers).values({ villageId: village.id, userId: "guest" });
  await addMember(db, "history", "vm_history", { homeArea: "en" });
  await db.insert(villageInvites).values(Array.from({ length: VILLAGE_INVITE_DAILY_LIMIT - 2 }, (_, n) => ({ villageId: village.id, userId: "history", invitedBy: "owner", kind: n % 2 ? "owner" : "join", state: "cancelled", createdAt: now, respondedAt: now })));
  for (let n = 0; n < 2; n++) {
    const target = n === 0 ? "guest" : `vm_target${n}`;
    if (n) await addMember(db, target, target, { homeArea: "en" });
    expect(await inviteToVillage(db, "owner", "club", n ? target : "vm_guest", n ? "join" : "owner", now)).toMatchObject({ ok: true });
    expect(await cancelVillageInvite(db, "owner", "club", await pending(db, target), now)).toMatchObject({ ok: true });
  }
  expect(await inviteToVillage(db, "owner", "club", "vm_second", "join", now)).toEqual({ ok: false, error: "invite_limit" });
  expect(await db.select().from(villageInvites).where(eq(villageInvites.invitedBy, "owner"))).toHaveLength(VILLAGE_INVITE_DAILY_LIMIT);
  expect(await db.select().from(notifications).where(eq(notifications.kind, "village_invite"))).toHaveLength(2);
  expect(await inviteToVillage(db, "owner", "club", "vm_second", "join", new Date(now.getTime() + 86400000))).toMatchObject({ ok: true });
}, 30000);

it("waits after cancellation across villages and kinds, without treating cancellation as refusal", async () => {
  const { db, village } = await world(), now = new Date(), delay = VILLAGE_REINVITE_HOURS * 3600000;
  await db.insert(villageMembers).values({ villageId: village.id, userId: "guest" });
  await createVillage(db, "owner", { slug: "another", name: "Another", description: "", kind: "invite_public" });
  expect(await inviteToVillage(db, "owner", "club", " @VM_GUEST ", "owner", now)).toMatchObject({ ok: true });
  expect(await cancelVillageInvite(db, "owner", "club", await pending(db), now)).toMatchObject({ ok: true });
  expect(await inviteToVillage(db, "owner", "another", "vm_guest", "join", new Date(now.getTime() + delay - 1))).toEqual({ ok: false, error: "invite_wait" });
  expect(await inviteToVillage(db, "owner", "another", "vm_guest", "join", new Date(now.getTime() + delay))).toMatchObject({ ok: true });
  await respondToVillageInvite(db, "guest", "another", await pending(db), "declined", new Date(now.getTime() + delay));
  expect(await inviteToVillage(db, "owner", "club", "vm_guest", "owner", new Date(now.getTime() + 2 * delay - 1))).toEqual({ ok: false, error: "invite_wait" });
  expect(await inviteToVillage(db, "owner", "club", "vm_guest", "owner", new Date(now.getTime() + 2 * delay))).toMatchObject({ ok: true });
  // A different sender does not inherit this pair's cooldown.
  await db.insert(villageMembers).values({ villageId: village.id, userId: "second", role: "owner" });
  expect(await inviteToVillage(db, "second", "another", "vm_guest", "join", now)).toMatchObject({ error: "forbidden" });
  await cancelVillageInvite(db, "owner", "club", await pending(db), new Date(now.getTime() + 2 * delay));
  expect(await inviteToVillage(db, "second", "club", "vm_guest", "owner", new Date(now.getTime() + 2 * delay))).toMatchObject({ ok: true });
});

it("shares a roster with ordinary members but never queries one in language villages", async () => {
  const { db, village } = await world();
  await db.insert(villageMembers).values({ villageId: village.id, userId: "guest" });
  const query = vi.spyOn(db, "select");
  expect(await villageManagement(db, village.id, "guest")).toMatchObject({ roster: [{ handle: "vm_guest" }, { handle: "vm_owner" }], invites: [], canReadRoster: true });
  expect(query.mock.calls.some(([columns]) => Object.values(columns ?? {}).includes(profiles.handle))).toBe(true);
  query.mockClear(); vi.stubEnv("OPERATOR_EMAILS", "second@example.com");
  const language = (await villageBySlug(db, "en"))!;
  query.mockClear();
  expect(await villageManagement(db, language.id, "second")).toMatchObject({ roster: [], canReadRoster: false });
  expect(query.mock.calls.some(([columns]) => Object.values(columns ?? {}).includes(profiles.handle))).toBe(false);
  query.mockClear(); vi.stubEnv("VILLAGES", "");
  expect((await villageManagement(db, village.id, "owner")).roster).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});

it("paginates owner/operator rosters and counts the sole owner independently of the current page", async () => {
  const { db, village } = await world();
  const ids = Array.from({ length: VILLAGE_ROSTER_PAGE_SIZE }, (_, n) => `aaa${String(n).padStart(2, "0")}`);
  await db.insert(user).values(ids.map(id => ({ id, name: "", email: `${id}@example.com`, emailVerified: true })));
  await db.insert(profiles).values(ids.map(id => ({ userId: id, handle: id, handleKey: id, homeArea: "en", readLangs: ["ja"] })));
  await db.insert(villageMembers).values(ids.map(userId => ({ villageId: village.id, userId })));
  const first = await villageManagement(db, village.id, "owner"), second = await villageManagement(db, village.id, "owner", 2);
  expect(first).toMatchObject({ rosterPage: 1, rosterHasNext: true, lastOwner: true });
  expect(first.roster).toHaveLength(VILLAGE_ROSTER_PAGE_SIZE);
  expect(first.roster.every(row => row.role === "member")).toBe(true);
  expect(second).toMatchObject({ rosterPage: 2, rosterHasNext: false, lastOwner: true, roster: [{ handle: "vm_owner" }] });
  vi.stubEnv("OPERATOR_EMAILS", "second@example.com");
  expect((await villageManagement(db, village.id, "second")).roster).toEqual(first.roster);
  expect((await villageManagement(db, village.id, "second")).invites).toEqual([]);
  expect(await inviteToVillage(db, "second", "club", "vm_guest", "join")).toMatchObject({ error: "forbidden" });
}, 30000);

it("cancels pending invitations from an owner who leaves while preserving other owners' invitations", async () => {
  const { db, village } = await world();
  await db.insert(villageMembers).values({ villageId: village.id, userId: "second", role: "owner" });
  await addMember(db, "other", "vm_other", { homeArea: "en" });
  await inviteToVillage(db, "owner", "club", "vm_guest", "join"); const id = await pending(db);
  await inviteToVillage(db, "second", "club", "vm_other", "join");
  expect(await changeVillageMembership(db, "owner", "club", "leave")).toBe(true);
  expect(await incomingVillageInvites(db, "guest")).toEqual([]);
  expect((await db.select().from(villageInvites).where(eq(villageInvites.id, id)))[0]).toMatchObject({ state: "cancelled", respondedAt: expect.any(Date) });
  expect((await villageManagement(db, village.id, "second")).invites).toMatchObject([{ handle: "vm_other" }]);
  expect(await inviteToVillage(db, "second", "club", "vm_guest", "join")).toMatchObject({ ok: true });
});

it("keeps a co-owner and their pending invitations when another owner tries to remove them", async () => {
  const { db, village } = await world();
  await db.insert(villageMembers).values({ villageId: village.id, userId: "second", role: "owner" });
  await inviteToVillage(db, "second", "club", "vm_guest", "join"); const id = await pending(db);
  expect(await removeVillageMember(db, "owner", "club", "vm_second", "Reason")).toMatchObject({ ok: false, error: "forbidden" });
  expect((await db.select().from(villageInvites).where(eq(villageInvites.id, id)))[0].state).toBe("pending");
  expect(await incomingVillageInvites(db, "guest")).toHaveLength(1);
});

it("replaces orphaned invitations after the sender's account is deleted", async () => {
  const { db, village } = await world();
  await db.insert(villageMembers).values({ villageId: village.id, userId: "second", role: "owner" });
  await inviteToVillage(db, "owner", "club", "vm_guest", "join"); const id = await pending(db);
  await db.delete(user).where(eq(user.id, "owner"));
  expect(await inviteToVillage(db, "second", "club", "vm_guest", "join")).toMatchObject({ ok: true });
  expect((await db.select().from(villageInvites).where(eq(villageInvites.id, id)))[0].state).toBe("cancelled");
});

it("bounds pending invitation pages with stable ordering and keeps them owner-only", async () => {
  const { db, village } = await world();
  const ids = Array.from({ length: VILLAGE_ROSTER_PAGE_SIZE + 1 }, (_, n) => `vpage${n}`);
  await db.insert(user).values(ids.map(id => ({ id, name: "", email: `${id}@example.com`, emailVerified: true })));
  await db.insert(profiles).values(ids.map(id => ({ userId: id, handle: id, handleKey: id, homeArea: "en", readLangs: ["en"] })));
  const createdAt = new Date();
  await db.insert(villageInvites).values(ids.map(userId => ({ villageId: village.id, userId, invitedBy: "owner", kind: "join", createdAt })));
  const first = await villageManagement(db, village.id, "owner", 1, 1);
  const second = await villageManagement(db, village.id, "owner", 1, 2);
  expect(first.invites).toHaveLength(VILLAGE_ROSTER_PAGE_SIZE);
  expect(first).toMatchObject({ invitesPage: 1, invitesHasNext: true });
  expect(second.invites).toHaveLength(1);
  expect(second).toMatchObject({ invitesPage: 2, invitesHasNext: false });
  expect(new Set([...first.invites, ...second.invites].map(row => row.id)).size).toBe(ids.length);
  vi.stubEnv("OPERATOR_EMAILS", "second@example.com");
  expect((await villageManagement(db, village.id, "second", 1, 2)).invites).toEqual([]);
}, 30000);

it("validates one-line names, multiline descriptions, directional controls and ID-shaped slugs", async () => {
  const { db } = await world();
  for (const value of ["a\nb", "a\rb", "a\tb", "a\u0085b", "a\u2028b", "a\u2029b", "a\u0000b", "a\u007fb", "a\u061cb", "a\u200eb", "a\u200fb", "a\u202ab", "a\u202eb", "a\u2066b", "a\u2069b"]) {
    expect(await editVillage(db, "owner", "club", { name: value, description: "" })).toMatchObject({ error: "invalid" });
    expect(await createVillage(db, "guest", { slug: "invalid-text", name: value, description: "", kind: "open" })).toMatchObject({ error: "invalid" });
  }
  for (const description of ["a\tb", "a\u0007b", "a\u0085b", "a\u202eb", "a\u2066b"]) {
    expect(await editVillage(db, "owner", "club", { name: "Valid", description })).toMatchObject({ error: "invalid" });
    expect(await createVillage(db, "guest", { slug: "invalid-text", name: "Valid", description, kind: "open" })).toMatchObject({ error: "invalid" });
  }
  expect(await editVillage(db, "owner", "club", { name: "  Plain 村  ", description: "  first\r\nsecond\nthird  " })).toMatchObject({ ok: true });
  expect(await villageBySlug(db, "club")).toMatchObject({ name: "Plain 村", description: "first\r\nsecond\nthird" });
  for (const slug of ["0123456789abcdef0123456789abcdef", "a".repeat(32), "1".repeat(32)]) {
    expect(validVillageSlug(slug)).toBe(false);
    expect(await createVillage(db, "guest", { slug, kind: "open", name: "Valid", description: "" })).toMatchObject({ error: "invalid" });
  }
  for (const slug of ["a".repeat(31), "a".repeat(33), "g".repeat(32), "0123456789abcdef-0123456789abcdef"]) expect(validVillageSlug(slug)).toBe(true);
});

it("edits a language village description as configuration while ignoring forged names", async () => {
  const { db } = await world(); vi.stubEnv("OPERATOR_EMAILS", "second@example.com");
  for (const name of [null, "English village", "bad\nname\u202e"]) {
    expect(await editVillage(db, "second", "en", { name, description: "First line\nSecond line" })).toMatchObject({ ok: true });
    expect(await villageBySlug(db, "en")).toMatchObject({ name: "", description: "First line\nSecond line" });
  }
});

it("rejects invisible village names and names without a letter or number on creation and editing", async () => {
  const { db } = await world();
  const formats = ["\u200b", "\u2060", "\ufeff", "\u00ad"];
  const fillers = ["\u115f", "\u1160", "\u3164", "\uffa0"];
  const names = [...formats, ...formats.map(char => `Visible${char}name`), ...fillers, ...fillers.map(char => `Visible${char}name`), "!!!", "😀", "👩\u200d💻", "\u0301", "\u200c", "\u200d"];
  for (const name of names) {
    expect(await createVillage(db, "guest", { slug: "invisible-name", name, description: "", kind: "open" })).toEqual({ ok: false, error: "invalid" });
    expect(await editVillage(db, "owner", "club", { name, description: "" })).toEqual({ ok: false, error: "invalid" });
  }
  expect(await villageBySlug(db, "invisible-name")).toBeNull();
  expect((await villageBySlug(db, "club"))?.name).toBe("Club");
});

it("preserves script-shaping joiners and rejects other format characters in descriptions", async () => {
  const { db } = await world();
  const description = "دهکده\u200cها\nक्\u200dष";
  for (const [index, name] of ["دهکده\u200cها", "क्\u200dष गाँव", "Village 👩\u200d💻", "١٢٣"].entries()) {
    expect(await createVillage(db, "guest", { slug: `visible-${index}`, name, description, kind: "open" })).toMatchObject({ ok: true });
    expect(await editVillage(db, "owner", "club", { name, description })).toMatchObject({ ok: true });
    expect(await villageBySlug(db, "club")).toMatchObject({ name, description });
  }
  for (const char of ["\u200b", "\u2060", "\ufeff", "\u00ad"]) {
    expect(await createVillage(db, "second", { slug: "invalid-description", name: "Visible", description: `First${char}second`, kind: "open" })).toEqual({ ok: false, error: "invalid" });
    expect(await editVillage(db, "owner", "club", { name: "Visible", description: `First${char}second` })).toEqual({ ok: false, error: "invalid" });
  }
  // Descriptions do not acquire the name-only letter/number or filler rules.
  expect(await editVillage(db, "owner", "club", { name: "Visible", description: "😀\n\u3164" })).toMatchObject({ ok: true });
});
