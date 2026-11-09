import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roles, user } from "~/lib/db/schema";
import { ensureOperatorRow, getModScope, grantModerator, inScope, isModerator, listModerators, NO_SCOPE, revokeModerator, searchMembers, syncOperatorRoles } from "~/lib/roles.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Roles: OPERATOR_EMAILS is authoritative for operators; operator rows in roles support queries and records.
async function setup() {
  const db = await createTestDb();
  await addMember(db, "op", "opal", { email: "op@example.com" });
  await addMember(db, "mod", "moriko", { readLangs: ["ja"] });
  await addMember(db, "mem", "member_x");
  return db;
}

describe("the roles table", () => {
  it("accepts an operator without a language and a moderator with one, and refuses anything else", async () => {
    const db = await setup();
    await db.insert(roles).values({ userId: "op", role: "operator", lang: null });
    await db.insert(roles).values({ userId: "mod", role: "moderator", lang: "ja" });
    const bad = async (values: typeof roles.$inferInsert, name: RegExp) => {
      const error = await db.insert(roles).values(values).then(() => null, (e: unknown) => e as { cause?: { message?: string; constraint?: string }; message: string });
      expect(`${error?.cause?.constraint ?? ""} ${error?.cause?.message ?? ""} ${error?.message ?? ""}`, String(name)).toMatch(name);
    };
    // An unknown role violates both constraints; which one is reported first is unspecified.
    await bad({ userId: "mod", role: "admin", lang: null }, /roles_(role|lang)_check/);
    await bad({ userId: "mod", role: "moderator", lang: null }, /roles_lang_check/);
    await bad({ userId: "mod", role: "moderator", lang: "xx" }, /roles_lang_check/);
    await bad({ userId: "op", role: "operator", lang: "ja" }, /roles_lang_check/);
  });

  it("is unique per (user, role, language), also for the operator role whose language is null", async () => {
    const db = await setup();
    await db.insert(roles).values({ userId: "op", role: "operator", lang: null });
    const dup = (values: typeof roles.$inferInsert) => db.insert(roles).values(values).then(() => null, (e: unknown) => e as { cause?: { constraint?: string } });
    expect((await dup({ userId: "op", role: "operator", lang: null }))?.cause?.constraint).toBe("roles_user_role_lang_unique");
    await db.insert(roles).values({ userId: "mod", role: "moderator", lang: "ja" });
    expect((await dup({ userId: "mod", role: "moderator", lang: "ja" }))?.cause?.constraint).toBe("roles_user_role_lang_unique");
    // A different language is a separate role.
    await db.insert(roles).values({ userId: "mod", role: "moderator", lang: "en" });
  });
});

describe("granting and revoking moderators", () => {
  it("appoints a member per language, once; only members; only languages", async () => {
    const db = await setup();
    expect(await grantModerator(db, "op", "mod", "ja")).toEqual({ ok: true, added: true });
    expect(await grantModerator(db, "op", "mod", "ja")).toEqual({ ok: true, added: false });
    expect(await grantModerator(db, "op", "mod", "th")).toEqual({ ok: true, added: true });
    expect(await grantModerator(db, "op", "mod", "xx")).toEqual({ ok: false, error: "invalid_lang" });
    expect(await grantModerator(db, "op", "mod", "other")).toEqual({ ok: false, error: "invalid_lang" });
    expect(await grantModerator(db, "op", "nobody", "ja")).toEqual({ ok: false, error: "not_a_member" });
    const list = await listModerators(db);
    expect(list.map((r) => [r.handle, r.lang, r.grantedByHandle])).toEqual([
      ["moriko", "ja", "opal"],
      ["moriko", "th", "opal"],
    ]);
  });

  it("revokes one language and leaves the others; revoking what is not held does nothing", async () => {
    const db = await setup();
    await grantModerator(db, "op", "mod", "ja");
    await grantModerator(db, "op", "mod", "th");
    expect(await revokeModerator(db, "mod", "ja")).toEqual({ ok: true, removed: true });
    expect(await revokeModerator(db, "mod", "ja")).toEqual({ ok: true, removed: false });
    expect(await revokeModerator(db, "mod", "zz")).toEqual({ ok: false, error: "invalid_lang" });
    expect((await getModScope(db, { id: "mod", email: "mod@example.com" }, {})).langs).toEqual(["th"]);
  });
});

describe("the scope of a user", () => {
  it("is the languages of the moderator, everything for an operator listed in OPERATOR_EMAILS, nothing for a member", async () => {
    const db = await setup();
    await grantModerator(db, "op", "mod", "ja");
    await grantModerator(db, "op", "mod", "en");
    const env = { OPERATOR_EMAILS: " OP@example.com " };
    const mod = await getModScope(db, { id: "mod", email: "mod@example.com" }, env);
    expect(mod).toEqual({ operator: false, langs: ["en", "ja"] });
    expect(isModerator(mod)).toBe(true);
    // A Japanese moderator cannot handle English posts because they are out of scope.
    expect(inScope(mod, "ja")).toBe(true);
    expect(inScope(mod, "th")).toBe(false);
    const op = await getModScope(db, { id: "op", email: "op@example.com" }, env);
    expect(op).toEqual({ operator: true, langs: [] });
    expect(inScope(op, "th")).toBe(true);
    const member = await getModScope(db, { id: "mem", email: "mem@example.com" }, env);
    expect(member).toEqual(NO_SCOPE);
    expect(isModerator(member)).toBe(false);
    // The environment variable is authoritative for operators: removing someone revokes the role immediately, even if a database row remains.
    await ensureOperatorRow(db, { id: "op", email: "op@example.com" }, env);
    expect((await getModScope(db, { id: "op", email: "op@example.com" }, { OPERATOR_EMAILS: "" })).operator).toBe(false);
  });
});

describe("operator rows follow OPERATOR_EMAILS", () => {
  it("are added for listed users when they are seen, and removed at sync when their address is no longer listed", async () => {
    const db = await setup();
    const env = { OPERATOR_EMAILS: "op@example.com" };
    const rows = () => db.select({ userId: roles.userId, role: roles.role, lang: roles.lang }).from(roles).where(eq(roles.role, "operator"));
    // Nonoperators cannot enter.
    await ensureOperatorRow(db, { id: "mem", email: "mem@example.com" }, env);
    expect(await rows()).toEqual([]);
    await ensureOperatorRow(db, { id: "op", email: "op@example.com" }, env);
    await ensureOperatorRow(db, { id: "op", email: "op@example.com" }, env);
    expect(await rows()).toEqual([{ userId: "op", role: "operator", lang: null }]);
    // Startup synchronization removes unlisted operator rows and inserts missing listed ones; leave moderator rows untouched.
    await grantModerator(db, "op", "mod", "ja");
    await db.insert(user).values({ id: "op2", name: "", email: "Second@Example.com", emailVerified: true });
    expect(await syncOperatorRoles(db, { OPERATOR_EMAILS: "second@example.com" })).toEqual({ removed: 1, added: 1 });
    expect(await rows()).toEqual([{ userId: "op2", role: "operator", lang: null }]);
    expect(await syncOperatorRoles(db, { OPERATOR_EMAILS: "second@example.com" })).toEqual({ removed: 0, added: 0 });
    expect((await listModerators(db)).length).toBe(1);
    // An empty list removes all operator rows.
    expect(await syncOperatorRoles(db, {})).toEqual({ removed: 1, added: 0 });
    expect(await rows()).toEqual([]);
  });
});

describe("searching members", () => {
  it("finds members by part of the display name, ignoring case, with LIKE characters taken literally", async () => {
    const db = await setup();
    await addMember(db, "axb", "axb");
    await addMember(db, "a_b", "a_b");
    await grantModerator(db, "op", "mod", "ja");
    expect((await searchMembers(db, "MORI")).map((h) => [h.handle, h.moderatorLangs])).toEqual([["moriko", ["ja"]]]);
    // "_" is a literal underscore, not a wildcard for one character.
    expect((await searchMembers(db, "a_b")).map((h) => h.handle)).toEqual(["a_b"]);
    expect((await searchMembers(db, "_")).map((h) => h.handle).sort()).toEqual(["a_b", "member_x"]);
    expect(await searchMembers(db, "%")).toEqual([]);
    expect(await searchMembers(db, "  ")).toEqual([]);
    expect(await searchMembers(db, "nobody-here")).toEqual([]);
  });
});

describe("requireOperator (the route gate) uses the roles", () => {
  let h: RouteHarness;
  const saved = process.env.OPERATOR_EMAILS;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    await h.signIn("moriko", { homeArea: "ja" });
    await h.signIn("taro", { homeArea: "ja" });
  });
  afterAll(() => {
    h.restore();
    if (saved === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = saved;
  });

  it("lets an operator into /admin/roles and records the operator row; a moderator or a member gets 404", async () => {
    const { loader, action } = await import("~/routes/admin-roles");
    process.env.OPERATOR_EMAILS = "hana@example.com";
    expect(await h.outcome(async () => (await loader(h.args(h.request("/admin/roles")))))).toMatchObject({ status: 302, location: "/login?next=%2Fadmin%2Froles" });
    await grantModerator(h.db, h.ids.hana, h.ids.moriko, "ja");
    expect(await h.outcome(async () => (await loader(h.args(h.request("/admin/roles", { as: "moriko" })))))).toMatchObject({ status: 404 });
    expect(await h.outcome(async () => (await loader(h.args(h.request("/admin/roles", { as: "taro" })))))).toMatchObject({ status: 404 });
    expect(await h.outcome(() => action(h.args(h.request("/admin/roles", { as: "moriko", form: { intent: "grant", userId: h.ids.taro, lang: "ja" } }))))).toMatchObject({ status: 404 });
    const ok = await h.outcome(async () => (await loader(h.args(h.request("/admin/roles?q=mori", { as: "hana" })))));
    expect(ok.status).toBe(200);
    expect((ok.value as { hits: Array<{ handle: string }> }).hits.map((x) => x.handle)).toEqual(["moriko"]);
    expect(await h.db.select({ userId: roles.userId }).from(roles).where(eq(roles.role, "operator"))).toEqual([{ userId: h.ids.hana }]);
  });

  it("the action appoints and removes a moderator (operators only)", async () => {
    const { action } = await import("~/routes/admin-roles");
    process.env.OPERATOR_EMAILS = "hana@example.com";
    const grant = await h.outcome(() => action(h.args(h.request("/admin/roles", { as: "hana", form: { intent: "grant", userId: h.ids.taro, lang: "th", q: "taro" } }))));
    expect(grant).toMatchObject({ status: 302, location: "/admin/roles?q=taro&saved=granted" });
    expect((await getModScope(h.db, { id: h.ids.taro, email: "taro@example.com" }, {})).langs).toEqual(["th"]);
    const revoke = await h.outcome(() => action(h.args(h.request("/admin/roles", { as: "hana", form: { intent: "revoke", userId: h.ids.taro, lang: "th" } }))));
    expect(revoke).toMatchObject({ status: 302 });
    expect((await getModScope(h.db, { id: h.ids.taro, email: "taro@example.com" }, {})).langs).toEqual([]);
    expect(await h.outcome(() => action(h.args(h.request("/admin/roles", { as: "hana", form: { intent: "grant", userId: h.ids.taro, lang: "xx" } }))))).toMatchObject({ status: 400 });
  });

  it("an address taken out of OPERATOR_EMAILS stops being an operator at once", async () => {
    const { loader } = await import("~/routes/admin-roles");
    process.env.OPERATOR_EMAILS = "";
    expect(await h.outcome(async () => (await loader(h.args(h.request("/admin/roles", { as: "hana" })))))).toMatchObject({ status: 404 });
  });
});

describe("revoking a member's tokens and Open-in-AI links (compromise response)", () => {
  let h: RouteHarness;
  const saved = process.env.OPERATOR_EMAILS;
  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "hana@example.com";
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    await h.signIn("victim", { homeArea: "ja" });
    await h.signIn("taro", { homeArea: "ja" });
  });
  afterAll(() => {
    h.restore();
    if (saved === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = saved;
  });

  it("revokes every token (read and draft) and bumps the generation of the signed links, for operators only and with a confirmation", async () => {
    const { action } = await import("~/routes/admin-roles");
    const { createApiToken, authenticateToken } = await import("~/lib/tokens.server");
    const { signOpenInAiToken, verifyOpenInAiToken } = await import("~/lib/open-in-ai.server");
    const { profiles: profilesTable, apiTokens } = await import("~/lib/db/schema");
    const read = await createApiToken(h.db, h.ids.victim, { name: "r", kind: "read" });
    const draft = await createApiToken(h.db, h.ids.victim, { name: "d", kind: "draft" });
    const other = await createApiToken(h.db, h.ids.taro, { name: "o", kind: "read" });
    if (!read.ok || !draft.ok || !other.ok) throw new Error("token failed");
    const link = signOpenInAiToken({ resource: "/latest.md", userId: h.ids.victim, generation: 0 });
    expect((await verifyOpenInAiToken(h.db, link, { resource: "/latest.md" })).ok).toBe(true);
    const form = { intent: "revoke-tokens", userId: h.ids.victim, q: "victim" };
    // Nonoperators get 404. Without confirmation, change nothing.
    expect(await h.outcome(() => action(h.args(h.request("/admin/roles", { as: "taro", form: { ...form, confirm: "1" } }))))).toMatchObject({ status: 404 });
    expect((await h.outcome(() => action(h.args(h.request("/admin/roles", { as: "hana", form }))))).status).toBe(400);
    expect((await authenticateToken(h.db, read.token)).ok).toBe(true);
    const res = await h.outcome(() => action(h.args(h.request("/admin/roles", { as: "hana", form: { ...form, confirm: "1" } }))));
    expect(res).toMatchObject({ status: 302, location: "/admin/roles?q=victim&saved=tokens&n=2" });
    expect(await authenticateToken(h.db, read.token)).toEqual({ ok: false, error: "invalid" });
    expect(await authenticateToken(h.db, draft.token)).toEqual({ ok: false, error: "invalid" });
    expect(await verifyOpenInAiToken(h.db, link, { resource: "/latest.md" })).toEqual({ ok: false, error: "revoked" });
    expect((await h.db.select().from(profilesTable).where(eq(profilesTable.userId, h.ids.victim)))[0].openInAiGeneration).toBe(1);
    // Other members' tokens stay unchanged.
    expect((await authenticateToken(h.db, other.token)).ok).toBe(true);
    expect((await h.db.select().from(apiTokens).where(eq(apiTokens.userId, h.ids.victim))).every((t) => t.revokedAt !== null)).toBe(true);
    // A nonmember ID has no effect.
    expect((await h.outcome(() => action(h.args(h.request("/admin/roles", { as: "hana", form: { intent: "revoke-tokens", userId: "nobody", confirm: "1" } }))))).status).toBe(400);
  });
});
