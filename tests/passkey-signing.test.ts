import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { signingCredential } from "./helpers/signing";
import { passkeyRegistrationOptions, verifyPasskeyRegistration, recoverPasskeys, removeOwnPasskey } from "~/lib/auth/passkeys.server";
import { passkey, profiles, session, signingChallenges, user, jobs } from "~/lib/db/schema";
import { isAllowedAuthEndpoint } from "~/lib/auth/endpoints.server";
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("hana"); await h.signIn("kim"); await h.signIn("boss", { email: "boss@example.com" }); });
afterAll(() => h.restore());
describe("passkey lifecycle barriers", () => {
  it("closes both Better Auth HTTP registration paths", () => {
    expect(isAllowedAuthEndpoint(new Request("http://localhost:5173/api/auth/passkey/generate-register-options"))).toBe(false);
    expect(isAllowedAuthEndpoint(new Request("http://localhost:5173/api/auth/passkey/verify-registration", { method: "POST" }))).toBe(false);
  });
  it("requires user verification for first enrollment and offers hybrid-capable options", async () => {
    const options = await passkeyRegistrationOptions(h.db, h.ids.kim, "First key");
    expect(options.needsProof).toBe(false);
    if (options.needsProof) throw new Error("Expected registration");
    expect(options.options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(options.options.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
  });
  it("requires an existing UV assertion before issuing additional-key creation options", async () => {
    const key = await signingCredential(h.db, h.ids.hana);
    const options = await passkeyRegistrationOptions(h.db, h.ids.hana, "Additional key");
    expect(options.needsProof).toBe(true);
    if (!options.needsProof) throw new Error("Expected proof");
    expect(options.options.userVerification).toBe("required");
    await expect(passkeyRegistrationOptions(h.db, h.ids.hana, "Additional key", { challenge: options.challenge, assertion: key.assert(options.options.challenge, { uv: false }) })).rejects.toMatchObject({ status: 403 });
    const created = await passkeyRegistrationOptions(h.db, h.ids.hana, "Additional key", { challenge: options.challenge, assertion: key.assert(options.options.challenge) });
    expect(created.needsProof).toBe(false);
    await expect(passkeyRegistrationOptions(h.db, h.ids.hana, "Additional key", { challenge: options.challenge, assertion: key.assert(options.options.challenge) })).rejects.toMatchObject({ status: 403 });
    expect((await h.db.select().from(signingChallenges).where(eq(signingChallenges.challenge, options.challenge)))[0].usedAt).not.toBeNull();
  });
  it("cannot delete the last passkey or treat a previously enrolled account as new", async () => {
    const keys = await h.db.select().from(passkey).where(eq(passkey.userId, h.ids.hana));
    await expect(removeOwnPasskey(h.db, h.ids.hana, keys[0].id)).rejects.toMatchObject({ status: 409 });
    await h.db.delete(passkey).where(eq(passkey.userId, h.ids.hana));
    await expect(passkeyRegistrationOptions(h.db, h.ids.hana, "Bypass key")).rejects.toMatchObject({ status: 409 });
  });
  it("requires an operator, an identity-check explanation, and revokes every session on recovery", async () => {
    await expect(recoverPasskeys(h.db, { id: h.ids.kim, email: "kim@example.com" }, h.ids.hana, "Verified outside email" )).rejects.toMatchObject({ status: 403 });
    const previous = process.env.OPERATOR_EMAILS; process.env.OPERATOR_EMAILS = "boss@example.com";
    try {
      await expect(recoverPasskeys(h.db, { id: h.ids.kim, email: "boss@example.com" }, h.ids.hana, "Forged operator email" )).rejects.toMatchObject({ status: 403 });
      await expect(recoverPasskeys(h.db, { id: h.ids.boss, email: "boss@example.com" }, h.ids.hana, "short")).rejects.toMatchObject({ status: 400 });
      const recovery = await recoverPasskeys(h.db, { id: h.ids.boss, email: "boss@example.com" }, h.ids.hana, "Verified identity independently");
      expect(recovery.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60 * 1000);
      expect(await h.db.select().from(session).where(eq(session.userId, h.ids.hana))).toHaveLength(0);
      expect((await passkeyRegistrationOptions(h.db, h.ids.hana, "Recovered key")).needsProof).toBe(false);
      expect((await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.hana)))[0].passkeyEnrolledAt).not.toBeNull();
      expect((await h.db.select().from(jobs).where(eq(jobs.kind, "send_passkey_notice")))).toHaveLength(1);
      await h.db.update(profiles).set({ passkeyRecoveryUntil: new Date(Date.now() - 1) }).where(eq(profiles.userId, h.ids.hana));
      await expect(passkeyRegistrationOptions(h.db, h.ids.hana, "Expired recovery")).rejects.toMatchObject({ status: 409 });
    } finally { process.env.OPERATOR_EMAILS = previous; }
  });
  it("serializes successful first registrations, then enrolls an additional key only after existing-key UV proof", async () => {
    await h.signIn("enrollment_race");
    const userId = h.ids.enrollment_race;
    const first = await passkeyRegistrationOptions(h.db, userId, "First");
    const second = await passkeyRegistrationOptions(h.db, userId, "Racing first");
    if (first.needsProof || second.needsProof) throw new Error("Unexpected enrolled account");
    const key1 = await signingCredential(h.db, userId, { enroll: false });
    const key2 = await signingCredential(h.db, userId, { enroll: false });
    const results = await Promise.allSettled([
      verifyPasskeyRegistration(h.db, userId, first.challenge, key1.register(first.options.challenge)),
      verifyPasskeyRegistration(h.db, userId, second.challenge, key2.register(second.options.challenge)),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const keys = await h.db.select().from(passkey).where(eq(passkey.userId, userId));
    expect(keys).toHaveLength(1);
    const existing = keys[0].credentialID === key1.id ? key1 : key2;
    const proof = await passkeyRegistrationOptions(h.db, userId, "Additional");
    if (!proof.needsProof) throw new Error("Expected existing-key proof");
    const approved = await passkeyRegistrationOptions(h.db, userId, "Additional", { challenge: proof.challenge, assertion: existing.assert(proof.options.challenge) });
    if (approved.needsProof) throw new Error("Expected registration options");
    const additional = await signingCredential(h.db, userId, { enroll: false });
    expect(await verifyPasskeyRegistration(h.db, userId, approved.challenge, additional.register(approved.options.challenge))).toMatchObject({ ok: true });
    expect(await h.db.select().from(passkey).where(eq(passkey.userId, userId))).toHaveLength(2);
    expect((await h.db.select().from(jobs).where(eq(jobs.kind, "send_passkey_notice"))).some(j => (j.payload as { userId?: string; action?: string }).userId === userId && (j.payload as { action?: string }).action === "added")).toBe(true);
  });

});
