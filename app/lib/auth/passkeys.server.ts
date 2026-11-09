import { isDeletedIdentity } from "../deleted-member";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Db } from "~/lib/db/client.server";
import { passkey, passkeyRecoveries, profiles, session, signingChallenges, user } from "~/lib/db/schema";
import { boundChallenge, canonicalSigningJson, lockSigningMember, SIGNING_TTL_MS, SigningError, signingSite, transportsOf, verifySignedAssertion } from "~/lib/signing.server";
import { enqueue } from "~/lib/jobs/queue.server";
import { SEND_PASSKEY_NOTICE_JOB } from "~/lib/jobs/mail-kinds";
import { isOperatorEmail } from "~/lib/operators.server";
import { revokeAllCredentials } from "./revoke-credentials.server";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const credentialIds = (keys: { credentialID: string }[]) => keys.map(k => k.credentialID).sort();
const validName = (name: unknown) => {
  if (typeof name !== "string" || name.length > 64) throw new SigningError("name_too_long", 400);
  return name.trim();
};
async function enrollmentState(tx: Db, userId: string, now: Date) {
  const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
  if (!profile) throw new SigningError("not_a_member");
  const keys = await tx.select().from(passkey).where(eq(passkey.userId, userId));
  if (!keys.length && profile.passkeyEnrolledAt !== null && !(profile.passkeyRecoveryUntil !== null && profile.passkeyRecoveryUntil > now)) throw new SigningError("operator_recovery_required", 409);
  return { profile, keys };
}

export async function passkeyRegistrationOptions(db: Db, userId: string, nameInput: unknown, proof?: { challenge: string; assertion: AuthenticationResponseJSON }, now = new Date()) {
  const name = validName(nameInput);
  return db.transaction(async tx => {
    await lockSigningMember(tx, userId);
    const { profile, keys } = await enrollmentState(tx, userId, now);
    const proofPayload = canonicalSigningJson({ version: 1, operation: "add-passkey-proof", userId, name, credentialIds: credentialIds(keys) });
    if (keys.length && !proof) {
      const challenge = boundChallenge(hash(proofPayload));
      const options = await generateAuthenticationOptions({ rpID: signingSite().rpId, challenge: Buffer.from(challenge, "base64url"), userVerification: "required", timeout: SIGNING_TTL_MS, allowCredentials: keys.map(k => ({ id: k.credentialID, transports: transportsOf(k.transports) })) });
      await tx.insert(signingChallenges).values({ challenge, userId, operation: "add-passkey-proof", payload: proofPayload, payloadHash: hash(proofPayload), formHash: hash(name), createdAt: now, expiresAt: new Date(now.getTime() + SIGNING_TTL_MS) });
      return { needsProof: true as const, challenge, options };
    }
    let proofCredentialId: string | null = null;
    if (keys.length) {
      const [issued] = await tx.select().from(signingChallenges).where(and(eq(signingChallenges.challenge, proof!.challenge), eq(signingChallenges.userId, userId))).for("update");
      if (!issued || issued.usedAt || issued.expiresAt <= now || issued.operation !== "add-passkey-proof" || issued.payload !== proofPayload) throw new SigningError("invalid_addition_proof");
      const existing = await verifySignedAssertion(tx, userId, issued.challenge, proof!.assertion);
      proofCredentialId = existing.credentialID;
      await tx.update(signingChallenges).set({ usedAt: now }).where(eq(signingChallenges.challenge, issued.challenge));
    } else if (proof) throw new SigningError("invalid_addition_proof");
    const payload = canonicalSigningJson({ version: 1, operation: "register-passkey", userId, name, credentialIds: credentialIds(keys), proofCredentialId, recoveryUntil: profile.passkeyRecoveryUntil?.toISOString() ?? null });
    const challenge = boundChallenge(hash(payload));
    const options = await generateRegistrationOptions({ rpID: signingSite().rpId, rpName: "tomola", userName: profile.handle, userID: new TextEncoder().encode(userId), userDisplayName: profile.handle, challenge: Buffer.from(challenge, "base64url"), timeout: SIGNING_TTL_MS, attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" }, excludeCredentials: keys.map(k => ({ id: k.credentialID, transports: transportsOf(k.transports) })) });
    await tx.insert(signingChallenges).values({ challenge, userId, operation: "register-passkey", payload, payloadHash: hash(payload), formHash: hash(name), createdAt: now, expiresAt: new Date(now.getTime() + SIGNING_TTL_MS) });
    return { needsProof: false as const, challenge, options };
  });
}

export async function verifyPasskeyRegistration(db: Db, userId: string, challenge: string, response: RegistrationResponseJSON, now = new Date()) {
  return db.transaction(async tx => {
    await lockSigningMember(tx, userId);
    const { profile, keys } = await enrollmentState(tx, userId, now);
    const [issued] = await tx.select().from(signingChallenges).where(and(eq(signingChallenges.challenge, challenge), eq(signingChallenges.userId, userId))).for("update");
    if (!issued || issued.usedAt || issued.expiresAt <= now || issued.operation !== "register-passkey") throw new SigningError("invalid_registration_challenge");
    const approved = JSON.parse(issued.payload) as { name: string; credentialIds: string[]; proofCredentialId: string | null; recoveryUntil: string | null };
    if (canonicalSigningJson(approved.credentialIds) !== canonicalSigningJson(credentialIds(keys)) || approved.recoveryUntil !== (profile.passkeyRecoveryUntil?.toISOString() ?? null) || (keys.length > 0 && !keys.some(k => k.credentialID === approved.proofCredentialId))) throw new SigningError("registration_changed", 409);
    let verification;
    try { verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: signingSite().origin, expectedRPID: signingSite().rpId, requireUserVerification: true, requireUserPresence: true }); }
    catch { throw new SigningError("invalid_registration"); }
    if (!verification.verified || !verification.registrationInfo.userVerified) throw new SigningError("user_verification_required");
    const info = verification.registrationInfo;
    const [duplicate] = await tx.select({ id: passkey.id }).from(passkey).where(eq(passkey.credentialID, info.credential.id));
    if (duplicate) throw new SigningError("credential_already_registered", 409);
    const id = randomUUID();
    await tx.insert(passkey).values({ id, userId, name: approved.name || null, credentialID: info.credential.id, publicKey: Buffer.from(info.credential.publicKey).toString("base64"), counter: info.credential.counter, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, transports: response.response.transports?.join(",") ?? "", createdAt: now, aaguid: info.aaguid });
    await tx.update(profiles).set({ passkeyEnrolledAt: profile.passkeyEnrolledAt ?? now, passkeyRecoveryUntil: null }).where(eq(profiles.userId, userId));
    await tx.update(signingChallenges).set({ usedAt: now }).where(eq(signingChallenges.challenge, challenge));
    // Queue the mandatory notice in the same transaction; delivery failure is retried by the worker.
    if (keys.length > 0 || profile.passkeyEnrolledAt !== null) await enqueuePasskeyNotice(tx, userId, "added", approved.name, now);
    return { ok: true as const, id };
  });
}

export async function removeOwnPasskey(tx: Db, userId: string, id: string) {
  const keys = await tx.select().from(passkey).where(eq(passkey.userId, userId));
  if (!keys.some(k => k.id === id)) return { ok: false as const, error: "not_found" as const };
  if (keys.length <= 1) throw new SigningError("last_passkey", 409);
  const key = keys.find(k => k.id === id)!;
  await tx.delete(passkey).where(and(eq(passkey.id, id), eq(passkey.userId, userId)));
  await enqueuePasskeyNotice(tx, userId, "removed", key.name ?? "", new Date());
  return { ok: true as const };
}

export async function enqueuePasskeyNotice(tx: Db, userId: string, action: "added" | "removed" | "recovery", name: string, at: Date) {
  await enqueue(tx, SEND_PASSKEY_NOTICE_JOB, { userId, action, name, at: at.toISOString() }, { dedupeKey: `passkey-notice:${randomUUID()}`, runAt: at });
}

// Called only from the operator's manual recovery CLI after independent identity checks. Sessions and all outstanding approvals are revoked atomically.
export async function recoverPasskeys(db: Db, operator: { id: string; email: string }, userId: string, note: string, now = new Date()) {
  if (isDeletedIdentity(operator.id, operator.email) || !isOperatorEmail(operator.email) || operator.id === userId) throw new SigningError("operator_required");
  if (note.trim().length < 10 || note.length > 4000) throw new SigningError("recovery_note_required", 400);
  return db.transaction(async tx => {
    await lockSigningMember(tx, userId);
    const [actualOperator] = await tx.select({ email: user.email }).from(user).where(eq(user.id, operator.id));
    if (!actualOperator || actualOperator.email !== operator.email || !isOperatorEmail(actualOperator.email)) throw new SigningError("operator_required");
    const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
    if (!profile || !profile.passkeyEnrolledAt) throw new SigningError("not_enrolled", 409);
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
    await tx.delete(passkey).where(eq(passkey.userId, userId));
    await revokeAllCredentials(tx, userId, now);
    await tx.update(signingChallenges).set({ usedAt: now }).where(eq(signingChallenges.userId, userId));
    await tx.update(profiles).set({ passkeyRecoveryUntil: expiresAt }).where(eq(profiles.userId, userId));
    await tx.insert(passkeyRecoveries).values({ userId, operatorId: operator.id, note: note.trim(), createdAt: now, expiresAt });
    await enqueuePasskeyNotice(tx, userId, "recovery", "", now);
    return { expiresAt };
  });
}
