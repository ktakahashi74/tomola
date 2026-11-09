import { useEffect } from "react";

// Register the service worker (public/sw.js, for installation on the home screen and the offline notice) on the client after hydration, without an inline script
// (the CSP nonce policy remains unchanged). Only register in production builds in a secure context (https or localhost); never in development, to avoid interference with Vite HMR.
// Silently discard failures (unsupported browsers, certificate errors or private browsing). The app continues to work without a service worker.
export function PwaRegistration({ pushEnabled = false, memberId = null }: { pushEnabled?: boolean; memberId?: string | null } = {}) {
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!pushEnabled || !("serviceWorker" in navigator)) return;
    let dispose: (() => void) | undefined;
    let mounted = true;
    void import("~/lib/push/lifecycle.client").then(module => { if (mounted) dispose = module.startPushLifecycle(); }).catch(() => {});
    return () => { mounted = false; dispose?.(); };
  }, [pushEnabled, memberId]);
  return null;
}
