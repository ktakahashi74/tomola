import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Db } from "~/lib/db/client.server";
import { passkey, profiles } from "~/lib/db/schema";
import { issueSignedWrite, previewSignedWrite } from "~/lib/signing.server";

// A real P-256 credential and assertion, without mocking the WebAuthn verifier. Only fixture enrollment is inserted directly.
export async function signingCredential(db: Db, userId: string, opts: { counterZero?: boolean; enroll?: boolean } = {}) {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x!, "base64url"), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y!, "base64url")]);
  const id = randomBytes(32).toString("base64url");
  if (opts.enroll !== false) {
  await db.insert(passkey).values({ id, userId, name: "Test authenticator", publicKey: publicKey.toString("base64"), credentialID: id, counter: 0, deviceType: opts.counterZero ? "multiDevice" : "singleDevice", backedUp: !!opts.counterZero, createdAt: new Date() });
  await db.update(profiles).set({ passkeyEnrolledAt: new Date() }).where(eq(profiles.userId, userId));
  }
  let counter = 0;
  return { id, publicKey, register(challenge: string): RegistrationResponseJSON {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: "http://localhost:5173", crossOrigin: false }));
    const authData = Buffer.alloc(55);
    createHash("sha256").update("localhost").digest().copy(authData);
    authData[32] = 0x45;
    authData.writeUInt16BE(32, 53);
    const bytes = Buffer.concat([authData, Buffer.from(id, "base64url"), publicKey]);
    const attestationObject = Buffer.concat([Buffer.from("a363666d74646e6f6e656761747453746d74a0686175746844617461", "hex"), Buffer.from([0x58, bytes.length]), bytes]);
    return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: clientDataJSON.toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] } };
  }, assert(challenge: string, options: { uv?: boolean; origin?: string; rpId?: string; counter?: number } = {}): AuthenticationResponseJSON {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: options.origin ?? "http://localhost:5173", crossOrigin: false }));
    const authData = Buffer.alloc(37);
    createHash("sha256").update(options.rpId ?? "localhost").digest().copy(authData);
    authData[32] = opts.counterZero ? 0x19 : 0x01;
    if (options.uv !== false) authData[32] |= 0x04;
    authData.writeUInt32BE(options.counter ?? (opts.counterZero ? 0 : ++counter), 33);
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]), pair.privateKey);
    return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { authenticatorData: authData.toString("base64url"), clientDataJSON: clientDataJSON.toString("base64url"), signature: signature.toString("base64url"), userHandle: Buffer.from(userId).toString("base64url") } };
  } };
}
export type TestSigningCredential = Awaited<ReturnType<typeof signingCredential>>;
export async function attachSigningProof(db: Db, userId: string, request: Request, credential: TestSigningCredential): Promise<Request> {
  const form = await request.clone().formData();
  const pathname = new URL(request.url).pathname;
  const preview = await previewSignedWrite(db, userId, pathname, form);
  const options = await issueSignedWrite(db, userId, pathname, form, preview.payloadHash);
  form.set("signatureChallenge", options.challenge);
  form.set("signatureAssertion", JSON.stringify(credential.assert(options.options.challenge)));
  const body = new URLSearchParams();
  for (const [name, value] of form.entries()) body.append(name, String(value));
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}
