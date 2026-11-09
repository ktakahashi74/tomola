import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

type PasskeyReturnTarget = "prompt" | "settings";
const marker = { prompt: "continue", settings: "continue-settings" } as const;

export function supportsPasskeyRegistration(): boolean {
  return typeof window.PublicKeyCredential === "function" && typeof navigator.credentials?.create === "function";
}

export function withPasskeyReturn(path: string, target: PasskeyReturnTarget): string {
  const url = new URL(path, "https://return.invalid");
  url.searchParams.set("passkey", marker[target]);
  return `${url.pathname}${url.search}${url.hash}`;
}

// Each surface owns its own marker, including when both appear in settings.
// Replace through the router before starting the ceremony, so links rendered
// from the current location also stop carrying the marker.
export function usePasskeyReturn({ target, fresh, ready = true, enabled = true, onContinue }: {
  target: PasskeyReturnTarget;
  fresh: boolean;
  ready?: boolean;
  enabled?: boolean;
  onContinue: (automatic: boolean) => Promise<void>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const continuation = useRef<{ key: string; path: string } | null>(null);
  useEffect(() => {
    // Wait for the replacement to render. Eligibility or dismissal may change
    // while its loaders run, and the callback must use the committed screen.
    const pending = continuation.current;
    if (pending !== null) {
      if (`${location.pathname}${location.search}${location.hash}` === pending.path) {
        continuation.current = null;
        if (fresh && ready && enabled && supportsPasskeyRegistration()) void onContinue(true);
      } else if (location.key !== pending.key) continuation.current = null;
      return;
    }
    if (!fresh || !ready) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("passkey") !== marker[target]) return;
    url.searchParams.delete("passkey");
    const path = `${url.pathname}${url.search}${url.hash}`;
    continuation.current = { key: location.key, path };
    void navigate(path, { replace: true, preventScrollReset: true, state: location.state });
  }, [location, navigate, target, fresh, ready, enabled, onContinue]);
}

// SimpleWebAuthn retains the native exception name. Browsers use this name for
// both a missing user gesture and a cancelled dialog; either can resume by click.
export function passkeyNeedsActivation(error: unknown): boolean {
  return error instanceof Error && error.name === "NotAllowedError";
}
