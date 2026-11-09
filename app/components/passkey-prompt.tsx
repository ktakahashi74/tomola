import { useEffect, useState } from "react";
import { afterInitialActivation } from "~/lib/initial-activation";
import Prompt from "./passkey-prompt-body";
import { supportsPasskeyRegistration } from "~/lib/passkey-return";
// Render the notice in the initial HTML so hydration never inserts it above the
// page. Unsupported browsers remove it; only a requested registration loads the WebAuthn client.
export function PasskeyPrompt({ eligible, preference, fresh }: { eligible: boolean; preference: { cookieName: string; deferred: boolean }; fresh: boolean }) {
  const [supported, setSupported] = useState(true);
  useEffect(() => afterInitialActivation(() => setSupported(supportsPasskeyRegistration())), []);
  return supported ? <Prompt key={preference.cookieName} eligible={eligible} preference={preference} fresh={fresh} /> : null;
}
