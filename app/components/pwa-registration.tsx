import { useEffect } from "react";
import { clearLocalDrafts } from "~/lib/local-draft";

// Register the service worker (public/sw.js, for installation on the home screen and the offline notice) on the client after hydration, without an inline script
// (the CSP nonce policy remains unchanged). Only register in production builds in a secure context (https or localhost); never in development, to avoid interference with Vite HMR.
// Silently discard failures (unsupported browsers, certificate errors or private browsing). The app continues to work without a service worker.
export function PwaRegistration({ pushEnabled = false, memberId = null, loggedOut = false }: { pushEnabled?: boolean; memberId?: string | null; loggedOut?: boolean } = {}) {
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
  useEffect(() => {
    // A successful logout is acknowledged by the next page's root loader.
    // Until then, cancelled and failed departures keep device recovery intact.
    const clearing = loggedOut && memberId === null;
    if (clearing) clearLocalDrafts();
    if (!pushEnabled || !("serviceWorker" in navigator)) return;
    let dispose: (() => void) | undefined;
    let mounted = true;
    void import("~/lib/push/lifecycle.client").then(module => {
      if (!mounted) return;
      if (clearing) void module.clearBrowserPush().catch(() => {});
      else dispose = module.startPushLifecycle();
    }).catch(() => {});
    return () => { mounted = false; dispose?.(); };
  }, [pushEnabled, memberId, loggedOut]);
  return null;
}
