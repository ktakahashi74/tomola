import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { InstallGuideSteps } from "./install-guide-steps";
import { isIosDevice, standaloneDisplay } from "~/lib/install-guide";
import { PUSH_BROWSER_KEY, beginPushChange, readyPushRegistration, withPushReconciliation, clearBrowserPush, pushBrowser, pushIdentity, pushRequest, rememberPushOwner } from "~/lib/push/lifecycle.client";
import { pushRestoreBrowser, pushSettingsState } from "~/lib/push/settings-state";
import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";

type Registration = { id: string; browser: string; os: string; createdAt: string; stoppedReason: string | null; authorizedUntil: string };
type ServerState = { userId: string; current: { id: string; stoppedReason: string | null; matchesSubscription: boolean; vapidPublicKey: string } | null; registrations: Registration[] };
type ClientState = { checked: boolean; ios: boolean; standalone: boolean; supported: boolean; permission: NotificationPermission; subscription: PushSubscription | null; server: ServerState | null; login: boolean };
const initial: ClientState = { checked: false, ios: false, standalone: false, supported: false, permission: "default", subscription: null, server: null, login: false };
function applicationKey(key: string) {
  return Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
}
export default function PushSettings({ publicKey }: { publicKey: string }) {
  const [client, setClient] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"accepted" | "failed" | "limit" | "rate_limited" | "checked" | null>(null);
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current) return false;
    refreshing.current = true;
    try { return await withPushReconciliation(async () => {
    const supported = window.isSecureContext && "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
    const local = { ios: isIosDevice(navigator), standalone: standaloneDisplay(), supported,
      permission: "Notification" in window ? Notification.permission : "default" as NotificationPermission };
    let subscription: PushSubscription | null = null;
    try {
      subscription = supported ? await (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription() ?? null : null;
      const server: ServerState = await pushRequest("state", { identity: pushIdentity(), subscription: subscription?.toJSON() ?? null });
      const browser = pushBrowser();
      if (subscription && ((browser?.userId && browser.userId !== server.userId) || !server.current || server.current.stoppedReason)) {
        await clearBrowserPush(); subscription = null;
      }
      rememberPushOwner(server.userId);
      setClient({ ...local, checked: true, subscription, server, login: false });
      return true;
    } catch (error) {
      const login = error instanceof Error && error.message === "login";
      setClient({ ...local, checked: true, subscription, server: null, login });
      if (!login) setMessage(error instanceof Error && error.message === "rate_limited" ? "rate_limited" : "failed");
      return false;
    }
    }); } finally { refreshing.current = false; }
  }, []);
  useEffect(() => {
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const changed = () => { void refresh(); };
    const stored = (event: StorageEvent) => { if (event.key === PUSH_BROWSER_KEY || event.key === null) void refresh(); };
    window.addEventListener("tomola:push-state", changed);
    window.addEventListener("storage", stored);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("tomola:push-state", changed); window.removeEventListener("storage", stored); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  const registration = client.server?.current;
  const reconnect = registration && ["expired", "key_changed"].includes(registration.stoppedReason ?? "");
  const state = !client.checked ? "checking" : pushSettingsState({ ...client, busy, subscription: !!client.subscription, registration: !!registration && (!registration.stoppedReason || !!reconnect),
    matches: !!client.server?.current?.matchesSubscription && client.server.current.vapidPublicKey === publicKey });
  const failed = (error: unknown) => { setMessage(error instanceof Error && error.message === "limit" ? "limit" : error instanceof Error && error.message === "rate_limited" ? "rate_limited" : "failed"); };
  const enable = () => {
    // The permission request runs synchronously from this click, before any
    // network request or awaited browser operation (required by iOS).
    const permission = Notification.requestPermission();
    const change = beginPushChange();
    setBusy(true); setMessage(null);
    void (async () => {
      try {
        if (await permission !== "granted") return;
        await change.ready;
        const identity = pushBrowser(true);
        if (!identity) throw new Error("storage");
        const registration = await readyPushRegistration();
        const old = await registration.pushManager.getSubscription();
        if (old) await old.unsubscribe();
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(publicKey) });
        const json = subscription.toJSON();
        await pushRequest("subscribe", { identity: pushIdentity(), subscription: { endpoint: json.endpoint, keys: json.keys } });
      } catch (error) { failed(error); }
      finally { change.finish(); setBusy(false); await refresh(); }
    })();
  };
  const stop = async (id?: string, all = false) => {
    const change = beginPushChange();
    setBusy(true); setMessage(null);
    try {
      await change.ready;
      await pushRequest("unsubscribe", { ...(id ? { id } : {}), all });
      if (all || id === pushIdentity()?.id) await clearBrowserPush();
    } catch (error) { failed(error); }
    finally { change.finish(); setBusy(false); await refresh(); }
  };
  const test = async () => {
    const change = beginPushChange();
    setBusy(true); setMessage(null);
    try {
      await change.ready; await pushRequest("test", { id: client.server?.current?.id, identity: pushIdentity() }); setMessage("accepted"); }
    catch (error) { failed(error); }
    finally { change.finish(); setBusy(false); await refresh(); }
  };
  const status = state === "checking" ? m.push_checking() : state === "unsupported" ? m.push_unsupported() : state === "install" ? m.push_install() : state === "registering" ? m.push_registering()
    : state === "active" ? m.push_active() : state === "blocked" ? m.push_blocked() : state === "reconnect" ? m.push_reconnect() : state === "login" ? m.push_login() : m.push_off();
  const others = client.server?.registrations.filter(row => row.id !== pushIdentity()?.id && !row.stoppedReason) ?? [];
  const buttonClass = "h-auto min-h-11 max-w-full whitespace-normal";
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return <section id="settings-push" aria-labelledby="settings-push-heading" className="scroll-mt-4 space-y-3" data-push-state={state}>
    <h2 id="settings-push-heading" className="text-xl font-semibold">{m.push_heading()}</h2>
    <p className="ui-help text-muted-foreground">{m.push_intro()}</p>
    <p role="status">{status}{message && <span className="block">{message === "accepted" ? m.push_test_accepted() : message === "checked" ? m.push_checked() : message === "limit" ? m.push_limit() : message === "rate_limited" ? m.error_rate_limited() : m.push_error()}</span>}</p>
    {state === "install" && <><InstallGuideSteps /><p className="ui-help">{m.install_guide_existing()}</p></>}
    {state === "blocked" && <p className="ui-help">{{ ios: m.push_restore_ios, firefox: m.push_restore_firefox, android: m.push_restore_android, edge: m.push_restore_edge,
      safari: m.push_restore_safari, chrome: m.push_restore_chrome, browser: m.push_restore_browser }[pushRestoreBrowser(agent, client.ios)]()}</p>}
    <div className="flex flex-wrap gap-2">
      {(state === "off" || state === "reconnect") && <Button type="button" className={buttonClass} disabled={busy} onClick={enable}>{m.push_enable()}</Button>}
      {state === "active" && <Button type="button" variant="outline" className={buttonClass} disabled={busy} onClick={() => void test()}>{m.push_test()}</Button>}
      {(client.server?.current && !client.server.current.stoppedReason || client.subscription) && <Button type="button" variant="outline" className={buttonClass} disabled={busy} onClick={() => void stop(client.server?.current?.id ?? pushIdentity()?.id)}>{m.push_stop()}</Button>}
      <Button type="button" variant="outline" className={buttonClass} disabled={busy} onClick={() => { setMessage(null); void refresh().then(ok => { if (ok) setMessage("checked"); }); }}>{m.push_refresh()}</Button>
      {state === "login" && <a href="/login?next=%2Fsettings%23settings-push" className="inline-flex min-h-11 items-center underline">{m.login_title()}</a>}
    </div>
    {state !== "unsupported" && state !== "install" && <><p className="ui-help text-muted-foreground">{m.push_stop_help()}</p>
    <p className="ui-help text-muted-foreground">{m.push_session_help()}</p></>}
    {!!others.length && <div className="space-y-2"><h3 className="font-semibold">{m.push_other_devices()}</h3><ul className="space-y-2">{others.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2"><span id={`push-device-${row.id}`}>{m.push_device({ browser: row.browser, os: row.os, date: new Intl.DateTimeFormat(getLocale(), { year: "numeric", month: "short", day: "numeric" }).format(new Date(row.createdAt)) })}</span><Button type="button" variant="outline" className={buttonClass} disabled={busy} aria-describedby={`push-device-${row.id}`} onClick={() => void stop(row.id)}>{m.push_stop()}</Button></li>)}</ul></div>}
    {!!client.server?.registrations.some(row => !row.stoppedReason) && <Button type="button" variant="outline" className={buttonClass} disabled={busy} onClick={() => void stop(undefined, true)}>{m.push_stop_all()}</Button>}
    <details id="push-privacy" className="ui-help space-y-2"><summary className="cursor-pointer min-h-11 py-3 underline">{m.push_privacy_heading()}</summary><p>{m.push_privacy()}</p><p>{m.push_privacy_content()}</p><a className="inline-flex min-h-11 items-center underline" href="/privacy">{m.footer_privacy()}</a></details>
  </section>;
}
