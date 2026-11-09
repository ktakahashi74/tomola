import { useEffect, useState } from "react";
import { afterInitialActivation } from "~/lib/initial-activation";

// Browser support is available only after the page becomes interactive.
export function usePasskeySupport(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => afterInitialActivation(() => setSupported("PublicKeyCredential" in window)), []);
  return supported;
}
