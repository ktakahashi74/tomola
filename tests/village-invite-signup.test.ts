import * as notices from "~/lib/notice-sources.server";
import { personalVillage } from "~/lib/personal-villages.server";
import { afterEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createAuth } from "~/lib/auth/auth.server";
import { invitationCookie, invitationCookieName, readInvitationCookie } from "~/lib/auth/invitation-cookie.server";
import { authSecret } from "~/lib/auth/secret.server";
import { chatConsents, invitations, notifications, profiles, villageMembers, villages } from "~/lib/db/schema";
import { createInvitation, findValidInvitationByToken, markInvitationUsed, revokeInvitation } from "~/lib/invitations.server";
import { createProfile } from "~/lib/profiles.server";
import { consumedInvitationVillage, createSignupInvitation, invitationVillage, signupVillageChoices } from "~/lib/signup-village.server";
import { addVillageMember, endVillage } from "~/lib/village-management.server";
import { changeVillageMembership, ensureLanguageVillages, languageVillage } from "~/lib/villages.server";
import { addMember, createTestDb } from "./helpers/db";
import { BASE, setupRouteHarness } from "./helpers/route-harness";
import { trialForm } from "./helpers/trial";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  for (const id of ["issuer_a", "issuer_b"]) await addMember(db, id, id, { homeArea: "en" });
  const [a, b] = await db.insert(villages).values([
    { slug: "signup-a", name: "Signup A", kind: "invite_public" },
    { slug: "signup-b", name: "Signup B", kind: "open" },
  ]).returning();
  await db.insert(villageMembers).values([{ villageId: a.id, userId: "issuer_a", role: "owner" }, { villageId: b.id, userId: "issuer_b", role: "owner" }]);
  return { db, a, b };
}
function browserCookie(id: string, now = new Date()) {
  return invitationCookie(new Request(BASE), id, authSecret(), now).split(";")[0];
}
async function register(db: Awaited<ReturnType<typeof createTestDb>>, email: string, cookie = "") {
  let token = "";
  const auth = createAuth(db, { baseURL: BASE, secret: authSecret(), sendMagicLink: async args => { token = args.token; } });
  await auth.api.signInMagicLink({ body: { email }, headers: new Headers() });
  const response = await auth.api.magicLinkVerify({ query: { token }, headers: new Headers({ cookie }), asResponse: true });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  return { auth, id: body.user.id, session: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
}

it("signs an expiring, host-scoped cookie and rejects tampering and duplicate cookies", () => {
  const now = new Date(), id = "12345678-1234-1234-1234-123456789abc", request = new Request("https://example.com/invite/token");
  const value = invitationCookie(request, id, "secret", now);
  expect(invitationCookieName(request)).toBe("__Host-tomola.invitation");
  expect(value).toContain("Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure");
  const read = (cookie: string, time = now) => readInvitationCookie(new Request(request.url, { headers: { cookie } }), "secret", time);
  expect(read(value.split(";")[0])).toBe(id);
  expect(read(value.replace(id, id.replace("1", "2")))).toBeNull();
  expect(read(value, new Date(now.getTime() + 3600000))).toBeNull();
  expect(read(`${value.split(";")[0]}; ${value.split(";")[0]}`)).toBeNull();
});

it("allows only owned active open and invite-public villages, including against forged submissions and future kinds", async () => {
  const { db, a, b } = await world();
  const [closed, ended] = await db.insert(villages).values([{ slug: "signup-closed", kind: "closed" }, { slug: "signup-ended", kind: "open", endedAt: new Date() }]).returning();
  const language = (await languageVillage(db, "en"))!;
  for (const villageId of [closed.id, ended.id, language.id]) await db.insert(villageMembers).values({ villageId, userId: "issuer_a", role: "owner" }).onConflictDoUpdate({ target: [villageMembers.villageId, villageMembers.userId], set: { role: "owner" } });
  expect(await signupVillageChoices(db, "issuer_a")).toEqual([{ id: a.id, name: a.name }]);
  for (const id of [b.id, closed.id, ended.id, language.id, "missing"]) expect(await createSignupInvitation(db, "issuer_a", "recipient@example.com", id)).toBeNull();
  // Simulate the schema admitting an unknown future kind, without admitting it
  // to this feature's allowlist.
  await db.execute(sql`alter table villages drop constraint villages_kind_check`);
  await db.update(villages).set({ kind: "future_kind" }).where(eq(villages.id, a.id));
  expect(await signupVillageChoices(db, "issuer_a")).toEqual([]);
  expect(await createSignupInvitation(db, "issuer_a", "recipient@example.com", a.id)).toBeNull();
  vi.stubEnv("VILLAGES", "");
  expect(await signupVillageChoices(db, "issuer_b")).toEqual([]);
  expect(await createSignupInvitation(db, "issuer_b", "recipient@example.com", b.id)).toBeNull();
  expect(await createSignupInvitation(db, "issuer_b", "recipient@example.com", null)).toBeTruthy();
});

it.each([["invite_public", "en"], ["open", "en"], ["invite_public", "other"]] as const)("consumes the opened %s invitation instead of a newer invitation and preserves %s defaults and departure", async (kind, homeArea) => {
  const { db, a, b } = await world();
  await db.update(villages).set({ kind }).where(eq(villages.id, a.id));
  const opened = await createInvitation(db, { email: "exact@example.com", createdBy: "issuer_a", villageId: a.id, now: new Date(Date.now() - 1000) });
  const latest = await createInvitation(db, { email: "exact@example.com", createdBy: "issuer_b", villageId: b.id });
  const invitation = (await findValidInvitationByToken(db, opened.token))!;
  const cookie = browserCookie(invitation.id);
  const member = await register(db, "exact@example.com", cookie);
  expect(await findValidInvitationByToken(db, opened.token)).toBeNull();
  expect(await findValidInvitationByToken(db, latest.token)).not.toBeNull();
  const result = await createProfile(db, member.id, { handle: "signup_exact", homeArea });
  expect(result).toMatchObject({ ok: true });
  const memberships = await db.select().from(villageMembers).where(eq(villageMembers.userId, member.id));
  expect(memberships.map(row => row.villageId).sort()).toEqual([a.id, ...(homeArea === "en" ? [(await languageVillage(db, "en"))!.id] : [])].sort());
  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, member.id));
  expect(profile.defaultVillageId).toBe((await personalVillage(db, member.id))!.id);
  expect(await db.select().from(chatConsents).where(eq(chatConsents.userId, member.id))).toEqual([]);
  expect(await db.select().from(notifications).where(eq(notifications.userId, member.id))).toMatchObject([{ kind: "village_added", villageId: a.id }]);
  expect(await changeVillageMembership(db, member.id, a.slug!, "leave")).toBe(true);
  if (kind === "invite_public") expect(await addVillageMember(db, "issuer_a", a.slug!, "signup_exact")).toMatchObject({ error: "self_left" });
});

it.each(["missing", "wrong_address", "expired", "revoked", "used", "tampered", "cookie_expired"])("keeps legacy registration without village enrollment for a %s remembered invitation", async state => {
  const { db, a, b } = await world();
  const email = "fallback@example.com";
  const opened = await createInvitation(db, { email: state === "wrong_address" ? "elsewhere@example.com" : email, createdBy: "issuer_a", villageId: a.id, now: new Date(Date.now() - 1000) });
  const invitation = (await findValidInvitationByToken(db, opened.token))!;
  if (state === "expired") await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(invitations.id, invitation.id));
  if (state === "revoked") await revokeInvitation(db, "issuer_a", invitation.id);
  if (state === "used") await markInvitationUsed(db, email, { usedBy: "previous-user", invitationId: invitation.id });
  const fallback = await createInvitation(db, { email, createdBy: "issuer_b", villageId: b.id });
  let cookie = state === "missing" ? "" : browserCookie(invitation.id, state === "cookie_expired" ? new Date(Date.now() - 3600000) : new Date());
  if (state === "tampered") cookie = cookie.replace(invitation.id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const member = await register(db, email, cookie);
  expect(await findValidInvitationByToken(db, fallback.token)).toBeNull();
  const result = await createProfile(db, member.id, { handle: "signup_fallback", homeArea: "other" });
  expect(result).toMatchObject({ ok: true });
  expect(await db.select().from(villageMembers).where(eq(villageMembers.userId, member.id))).toEqual([]);
  expect(await db.select().from(notifications).where(eq(notifications.userId, member.id))).toEqual([]);
  const [remembered] = await db.select().from(invitations).where(eq(invitations.id, invitation.id));
  expect(remembered.usedBy).toBe(state === "used" ? "previous-user" : null);
});

it("completes registration and consumes the invitation when saving its village association fails", async () => {
  const { db, a } = await world();
  const created = (await createSignupInvitation(db, "issuer_a", "association_failure@example.com", a.id))!;
  const invitation = (await findValidInvitationByToken(db, created.token))!;
  await db.execute(sql`create function reject_signup_association() returns trigger language plpgsql as $$ begin
    if new.identifier like 'signup-invitation:%' then raise exception 'PRIVATE_ASSOCIATION_MARKER'; end if;
    return new;
  end $$`);
  await db.execute(sql`create trigger reject_signup_association before insert on verification for each row execute function reject_signup_association()`);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const member = await register(db, created.email, browserCookie(invitation.id));
  expect(await findValidInvitationByToken(db, created.token)).toBeNull();
  expect(await db.select().from(invitations).where(eq(invitations.id, invitation.id))).toMatchObject([{ usedBy: member.id, usedAt: expect.any(Date) }]);
  expect(await createProfile(db, member.id, { handle: "association_failure", homeArea: "en" })).toMatchObject({ ok: true });
  expect(await db.select().from(villageMembers).where(eq(villageMembers.userId, member.id))).toMatchObject([{ villageId: (await languageVillage(db, "en"))!.id }]);
  expect(await db.select().from(notifications).where(eq(notifications.userId, member.id))).toEqual([]);
  expect(warn).toHaveBeenCalledWith("[auth] Signup invitation association failed", { invitationId: invitation.id }, expect.any(String));
  expect(JSON.stringify(warn.mock.calls)).not.toContain(created.email);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_ASSOCIATION_MARKER");
  const detail = warn.mock.calls.find(call => call[0] === "[auth] Signup invitation association failed")![2];
  expect(detail).not.toContain(invitation.id);
  expect(detail).not.toContain(member.id);
  expect((await register(db, created.email)).id).toBe(member.id);
});

it.each(["suspended", "trial_consent_required", "trial_restricted"])("completes registration without enrollment when the inviter is %s at profile creation", async reason => {
  const { db, a } = await world();
  const created = (await createSignupInvitation(db, "issuer_a", "stopped-inviter@example.com", a.id))!;
  const invitation = (await findValidInvitationByToken(db, created.token))!;
  const member = await register(db, created.email, browserCookie(invitation.id));
  if (reason === "suspended") await db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, "issuer_a"));
  else {
    vi.spyOn(notices, "trialParticipationRequired").mockReturnValue(true);
    await db.update(profiles).set(reason === "trial_restricted" ? { residenceCountry: "CN" } : { trialConsentVersion: null }).where(eq(profiles.userId, "issuer_a"));
  }
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await invitationVillage(db, invitation)).toBeNull();
  expect(await consumedInvitationVillage(db, member.id)).toBeNull();
  expect(await createProfile(db, member.id, { handle: "stopped_inviter_recipient", homeArea: "en" })).toMatchObject({ ok: true });
  expect(await db.select().from(villageMembers).where(eq(villageMembers.userId, member.id))).toMatchObject([{ villageId: (await languageVillage(db, "en"))!.id }]);
  expect(await db.select().from(notifications).where(eq(notifications.userId, member.id))).toEqual([]);
  expect(warn).toHaveBeenCalledWith("[signup-village] Enrollment skipped", { invitationId: invitation.id, reason });
  expect(JSON.stringify(warn.mock.calls)).not.toContain(created.email);
});

it.each(["owner_left", "ended"])("continues signup without joining when the destination is %s", async state => {
  const { db, a } = await world();
  const created = (await createSignupInvitation(db, "issuer_a", "changed@example.com", a.id))!;
  const invitation = (await findValidInvitationByToken(db, created.token))!;
  const member = await register(db, created.email, browserCookie(invitation.id));
  if (state === "owner_left") await db.delete(villageMembers).where(and(eq(villageMembers.villageId, a.id), eq(villageMembers.userId, "issuer_a")));
  else await endVillage(db, "issuer_a", a.slug!);
  expect(await invitationVillage(db, invitation)).toBeNull();
  expect(await createProfile(db, member.id, { handle: "signup_changed", homeArea: "en" })).toMatchObject({ ok: true });
  expect(await db.select().from(villageMembers).where(and(eq(villageMembers.userId, member.id), eq(villageMembers.villageId, a.id)))).toEqual([]);
});

it.each([null, "/t/123?lang=en", "reading_return"])("shows the consumed village and chooses the onboarding return destination (%s)", async next => {
  const h = await setupRouteHarness();
  try {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
    await ensureLanguageVillages(h.db);
    await addMember(h.db, "issuer", "signup_issuer", { homeArea: "en" });
    const [village] = await h.db.insert(villages).values({ slug: "onboarding-invite", name: "Inviting village", kind: "invite_public" }).returning();
    await h.db.insert(villageMembers).values({ villageId: village.id, userId: "issuer", role: "owner" });
    const created = (await createSignupInvitation(h.db, "issuer", "route@example.com", village.id))!;
    const invitation = (await findValidInvitationByToken(h.db, created.token))!;
    const remembered = browserCookie(invitation.id);
    const member = await register(h.db, created.email, remembered);
    (globalThis as { __tomolaAuth?: Promise<typeof member.auth> }).__tomolaAuth = Promise.resolve(member.auth);
    const cookie = `${member.session}${next === "reading_return" ? "; tomola.reading-return=%2Ft%2F456" : ""}`;
    const path = `/onboarding${next && next !== "reading_return" ? `?${new URLSearchParams({ next })}` : ""}`;
    const route = await import("~/routes/onboarding");
    expect(await route.loader(h.args(h.request(path, { headers: { cookie } })))).toMatchObject({ village: { name: village.name } });
    expect(await route.action(h.args(h.request(path, { headers: { cookie }, form: { ...trialForm, handle: "!", homeArea: "en" } })))).toMatchObject({ error: "invalid_handle" });
    const submit = () => route.action(h.args(h.request(path, { headers: { cookie }, form: { ...trialForm, handle: "signup_route", homeArea: "en" } })));
    const expected = next === "reading_return" ? "/t/456" : next ?? "/v/onboarding-invite";
    expect(await h.outcome(submit)).toMatchObject({ location: expected });
    expect(await h.outcome(submit)).toMatchObject({ location: expected });
    expect(await h.db.select().from(notifications).where(eq(notifications.userId, member.id))).toHaveLength(1);
  } finally { h.restore(); }
});
