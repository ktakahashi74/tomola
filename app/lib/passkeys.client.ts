import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

async function post(body: unknown) {
  const response = await fetch("/passkeys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "passkey_failed");
  return result;
}
export async function addVerifiedPasskey(name = ""): Promise<void> {
  let result = await post({ intent: "options", name });
  if (result.needsProof) {
    const assertion = await startAuthentication({ optionsJSON: result.options as PublicKeyCredentialRequestOptionsJSON });
    result = await post({ intent: "options", name, proof: { challenge: result.challenge, assertion } });
  }
  const response = await startRegistration({ optionsJSON: result.options as PublicKeyCredentialCreationOptionsJSON });
  await post({ intent: "verify", challenge: result.challenge, response });
}
