export const PUSH_BROWSER_KEY = "tomola:push-browser";
export type PushBrowser = { id: string; secret: string; userId?: string };
export function pushBrowser(create = false): PushBrowser | null {
  try {
    const raw = localStorage.getItem(PUSH_BROWSER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed.id === "string" && typeof parsed.secret === "string") return parsed;
    }
    if (!create) return null;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const value = { id: crypto.randomUUID(), secret: btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") };
    localStorage.setItem(PUSH_BROWSER_KEY, JSON.stringify(value));
    return value;
  } catch { return null; }
}
export function rememberPushOwner(userId: string) {
  const browser = pushBrowser();
  if (browser && browser.userId !== userId) localStorage.setItem(PUSH_BROWSER_KEY, JSON.stringify({ ...browser, userId }));
}
export const pushIdentity = () => { const value = pushBrowser(); return value ? { id: value.id, secret: value.secret } : null; };
export async function clearBrowserPush() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  await Promise.allSettled([
    (async () => { await (await registration?.pushManager?.getSubscription())?.unsubscribe(); })(),
    (async () => { for (const notification of await registration?.getNotifications() ?? []) notification.close(); })(),
  ]);
}
export function appendPushIdentity(form: FormData) {
  const identity = pushIdentity();
  if (identity) { form.set("push-id", identity.id); form.set("push-secret", identity.secret); }
}
// Longer than the server's own limit for a test send (10 seconds to the provider plus
// database work), so a slow provider does not show an error for a delivered test.
const PUSH_REQUEST_TIMEOUT_MS = 20_000;
export async function pushRequest(operation: string, value: Record<string, unknown>) {
  const response = await fetch(`/push/${operation}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS) });
  if (response.status === 401 || response.redirected) throw new Error("login");
  const result = await response.json();
  if (response.status === 429) throw new Error("rate_limited");
  if (!response.ok) throw new Error(result.error === "limit" ? "limit" : "failed");
  return result;
}

// Opt-in waits for already-running reconciliations, then keeps new ones out
// until the browser subscription and server registration agree again.
let changing = 0;
const reconciliations = new Set<Promise<unknown>>();
const idleWaiters = new Set<() => void>();
export function beginPushChange() {
  changing++;
  return { ready: Promise.allSettled([...reconciliations]), finish: () => {
    changing--;
    if (changing === 0) {
      for (const resume of idleWaiters) resume();
      idleWaiters.clear();
    }
  } };
}
export async function withPushReconciliation<T>(run: () => Promise<T>): Promise<T> {
  // Deferred checks are not active I/O: a new change must not wait on them.
  // Both background and newly mounted settings checks resume after the change.
  while (changing) await new Promise<void>(resolve => idleWaiters.add(resolve));
  const pending = run();
  reconciliations.add(pending);
  try { return await pending; } finally { reconciliations.delete(pending); }
}
export function readyPushRegistration(timeout = 8000): Promise<ServiceWorkerRegistration> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker")), timeout);
    navigator.serviceWorker.ready.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
export function startPushLifecycle() {
  let disposed = false;
  let running = false;
  const reconcile = async () => {
    if (running || disposed || !pushBrowser()) return;
    running = true;
    try {
      const updated = await withPushReconciliation(async () => {
        if (disposed) return false;
        const browser = pushBrowser();
        if (!browser) return false;
        try {
          const subscription = await (await navigator.serviceWorker?.getRegistration("/"))?.pushManager?.getSubscription();
          if (disposed) return false;
          const state = await pushRequest("state", { identity: pushIdentity(), subscription: subscription?.toJSON() ?? null });
          if (disposed) return false;
          if ((browser.userId && browser.userId !== state.userId) || !state.current || state.current.stoppedReason) await clearBrowserPush();
          rememberPushOwner(state.userId);
          return true;
        } catch (error) { if (!disposed && error instanceof Error && error.message === "login") await clearBrowserPush().catch(() => {}); }
        return false;
      });
      if (updated && !disposed) window.dispatchEvent(new Event("tomola:push-state"));
    } finally { running = false; }
  };
  const visible = () => { if (document.visibilityState === "visible") void reconcile(); };
  const formdata = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const path = new URL(form.action, location.href).pathname;
    const data = (event as FormDataEvent).formData;
    if (path === "/logout" || path === "/settings" && data.get("intent") === "revoke-other-sessions") appendPushIdentity(data);
  };
  document.addEventListener("formdata", formdata);
  document.addEventListener("visibilitychange", visible);
  void reconcile();
  return () => { disposed = true; document.removeEventListener("formdata", formdata); document.removeEventListener("visibilitychange", visible); };
}
