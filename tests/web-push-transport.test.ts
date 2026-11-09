import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { request } from "node:https";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateVapidKeys, pushConfig, webPushEnabled } from "~/lib/push/config.server";
import { pushEndpoint, publicPushAddress, validateSubscription } from "~/lib/push/endpoint.server";
import { classifyPushResponse, createPushSender, PushConnectionError, retryAfterSeconds } from "~/lib/push/send.server";
import { pushRestoreBrowser, pushSettingsState } from "~/lib/push/settings-state";
import { configurePush, pushKeys, subscription } from "./helpers/push";

vi.mock("node:https", () => ({ request: vi.fn() }));
beforeEach(() => { configurePush(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("validates the closed switch and matching P-256 VAPID keys without disclosing input", () => {
  expect(webPushEnabled({ WEB_PUSH: "" })).toBe(false);
  expect(pushConfig({})).toBeNull();
  for (const value of ["0", "true", " 1", " "]) expect(() => webPushEnabled({ WEB_PUSH: value })).toThrow("WEB_PUSH");
  expect(pushConfig()?.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
  for (const change of [{ VAPID_PRIVATE_KEY: "sensitive-value" }, { VAPID_PUBLIC_KEY: pushKeys().publicKey }, { VAPID_SUBJECT: "file:///private" }, { VAPID_SUBJECT: "mailto:no-address" }]) {
    try { pushConfig({ ...process.env, ...change }); throw new Error("unexpected acceptance"); }
    catch (error) { expect(String(error)).toContain("Invalid Web Push"); expect(String(error)).not.toContain("sensitive-value"); }
  }
});
it("generates VAPID pairs that the configuration check accepts, including private keys with leading zero bytes", () => {
  // About one pair in 256 has a leading zero byte; 2000 draws reach that case with near certainty.
  for (let i = 0; i < 2000; i++) {
    const keys = generateVapidKeys();
    expect(pushConfig({ WEB_PUSH: "1", VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:push@example.org" })?.publicKey).toBe(keys.publicKey);
  }
});
it("allows only supported HTTPS hosts with no credentials, alternate ports or suffix tricks", () => {
  for (const host of ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "wns2-by3p.notify.windows.com"]) expect(pushEndpoint(`https://${host}/opaque`).hostname).toBe(host);
  for (const endpoint of ["http://fcm.googleapis.com/wp/a", "https://fcm.googleapis.com.evil.example/wp/a", "https://fcm.googleapis.com:8443/wp/a", "https://x@fcm.googleapis.com/wp/a", "https://127.0.0.1/a", "https://fcm.googleapis.com/a#secret", "https://a.b.notify.windows.com/x", `https://fcm.googleapis.com/${"x".repeat(2048)}`]) expect(() => pushEndpoint(endpoint)).toThrow("Invalid push");
  expect(validateSubscription(subscription())).toBeTruthy();
  for (const keys of [{ p256dh: "x", auth: "x" }, { p256dh: "A".repeat(87), auth: "A".repeat(22) }]) expect(() => validateSubscription({ ...subscription(), keys })).toThrow();
});
it("rejects private, loopback, mapped, link-local and reserved DNS addresses", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2002:7f00:1::", "2001:db8::1", "bad"]) expect(publicPushAddress(address), address).toBe(false);
  expect(publicPushAddress("8.8.8.8")).toBe(true); expect(publicPushAddress("2606:4700:4700::1111")).toBe(true);
});
it("pins a public DNS address and encrypts payloads without following redirects", async () => {
  const post = vi.fn(async () => ({ status: 302 }));
  const resolve = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
  const send = createPushSender({ resolve: resolve as never, post });
  expect(await send(subscription(), "generic-secret-text", { ttl: 999999, topic: "opaque" })).toEqual({ kind: "operator" });
  expect(post).toHaveBeenCalledTimes(1);
  const [input] = post.mock.calls[0] as unknown as [{ address: string; body: Buffer; headers: Record<string, string>; signal: AbortSignal }];
  expect(input.address).toBe("8.8.8.8"); expect(input.body.toString()).not.toContain("generic-secret-text"); expect(Number(input.headers.TTL)).toBe(7200); expect(input.signal).toBeInstanceOf(AbortSignal);
});
it("never connects when any DNS answer is internal and never propagates upstream secrets", async () => {
  const post = vi.fn();
  const send = createPushSender({ resolve: (async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]) as never, post });
  expect(await send(subscription(), "test", { ttl: 1, topic: "opaque" })).toEqual({ kind: "operator" }); expect(post).not.toHaveBeenCalled();
  const fail = createPushSender({ resolve: (async () => { throw new Error("endpoint-and-key-secret"); }) as never });
  expect(JSON.stringify(await fail(subscription(), "test", { ttl: 1, topic: "opaque" }))).not.toContain("secret");
  vi.stubEnv("VAPID_PRIVATE_KEY", "invalid"); expect(await fail(subscription(), "test", { ttl: 1, topic: "opaque" })).toEqual({ kind: "operator" });
});
it("separates expiration, Retry-After, temporary and operator failures", () => {
  expect(classifyPushResponse(201)).toEqual({ kind: "accepted" });
  for (const code of [404, 410]) expect(classifyPushResponse(code).kind).toBe("gone");
  for (const code of [400, 401, 403, 413, 307]) expect(classifyPushResponse(code).kind).toBe("operator");
  expect(classifyPushResponse(429, "90")).toEqual({ kind: "retry", retryAfterSeconds: 90 });
  expect(classifyPushResponse(503).kind).toBe("retry");
  expect(retryAfterSeconds("Thu, 01 Jan 1970 00:02:00 GMT", 0)).toBe(120);
});
it("distinguishes all settings states using browser and server evidence", () => {
  const value = { ios: false, standalone: false, supported: true, busy: false, login: false, permission: "default" as NotificationPermission, subscription: false, registration: false, matches: false };
  expect(pushSettingsState(value)).toBe("off");
  expect(pushSettingsState({ ...value, ios: true })).toBe("install");
  expect(pushSettingsState({ ...value, supported: false })).toBe("unsupported");
  expect(pushSettingsState({ ...value, busy: true })).toBe("registering");
  expect(pushSettingsState({ ...value, permission: "denied" })).toBe("blocked");
  expect(pushSettingsState({ ...value, subscription: true })).toBe("reconnect");
  expect(pushSettingsState({ ...value, login: true })).toBe("login");
  expect(pushSettingsState({ ...value, permission: "granted", subscription: true, registration: true, matches: true })).toBe("active");
});
it("always shows a visible notification and permits only authenticated local opening paths", async () => {
  const listeners: Record<string, (event: unknown) => void> = {};
  const show = vi.fn(async () => {}); const open = vi.fn(async () => {});
  const self = { addEventListener: (kind: string, handler: (event: unknown) => void) => { listeners[kind] = handler; }, registration: { showNotification: show }, clients: { openWindow: open, matchAll: async () => [] }, location: { origin: "https://example.org" } };
  vm.runInNewContext(fs.readFileSync("public/sw.js", "utf8"), { self, URL });
  let pending: Promise<unknown> | undefined;
  const waitUntil = (promise: Promise<unknown>) => { pending = promise; };
  listeners.push({ data: { json: () => { throw new Error(); } }, waitUntil }); await pending;
  expect(show).toHaveBeenCalledWith("tomola", expect.objectContaining({ body: "tomola" }));
  const close = vi.fn(); listeners.notificationclick({ notification: { close, data: { url: "https://evil.example/" } }, waitUntil }); await pending;
  expect(open).toHaveBeenCalledWith("https://example.org/notifications"); expect(close).toHaveBeenCalled();
  listeners.notificationclick({ notification: { close, data: { url: "/notifications/1/open?push=2" } }, waitUntil }); await pending;
  expect(open).toHaveBeenLastCalledWith("https://example.org/notifications/1/open?push=2");
});


it("waits for capability reconciliation before declaring the browser unsupported", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: Settings } = await import("~/components/push-settings");
  const html = renderToStaticMarkup(createElement(Settings, { publicKey: process.env.VAPID_PUBLIC_KEY! }));
  expect(html).toContain('data-push-state="checking"');
});

it("tries validated DNS addresses in order under one transport deadline", async () => {
  const post = vi.fn().mockRejectedValueOnce(new PushConnectionError("IPv6 unreachable")).mockResolvedValue({ status: 201 });
  const send = createPushSender({ resolve: (async () => [{ address: "2606:4700:4700::1111", family: 6 }, { address: "8.8.8.8", family: 4 }]) as never, post });
  expect(await send(subscription(), "test", { ttl: 60, topic: "opaque" })).toEqual({ kind: "accepted" });
  expect(post.mock.calls.map(([input]) => input.address)).toEqual(["2606:4700:4700::1111", "8.8.8.8"]);
  expect(post.mock.calls[0][0].signal).toBe(post.mock.calls[1][0].signal);
});
it("navigates and focuses an existing same-origin window before opening another", async () => {
  const listeners: Record<string, (event: unknown) => void> = {};
  const focus = vi.fn(async () => {}); const navigate = vi.fn(async () => ({ focus })); const openWindow = vi.fn();
  const matchAll = vi.fn(async () => [{ url: "https://other.example/", navigate: vi.fn() }, { url: "https://example.org/settings", navigate }]);
  const self = { addEventListener: (kind: string, handler: (event: unknown) => void) => { listeners[kind] = handler; }, clients: { matchAll, openWindow }, location: { origin: "https://example.org" } };
  vm.runInNewContext(fs.readFileSync("public/sw.js", "utf8"), { self, URL });
  let pending: Promise<unknown> | undefined;
  listeners.notificationclick({ notification: { close: vi.fn(), data: { url: "/notifications/1/open?push=2" } }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
  await pending;
  expect(matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
  expect(navigate).toHaveBeenCalledWith("https://example.org/notifications/1/open?push=2"); expect(focus).toHaveBeenCalledOnce(); expect(openWindow).not.toHaveBeenCalled();
});

it("defers browser reconciliation until a subscription change completes", async () => {
  const { beginPushChange, withPushReconciliation } = await import("~/lib/push/lifecycle.client");
  const change = beginPushChange(); const run = vi.fn(async () => "reconciled");
  const pending = withPushReconciliation(run);
  try { await Promise.resolve(); expect(run).not.toHaveBeenCalled(); }
  finally { change.finish(); }
  expect(await pending).toBe("reconciled"); expect(run).toHaveBeenCalledOnce();
});

it.each([false, true])("only fails over before TLS is established (connected=%s)", async connected => {
  let attempts = 0;
  vi.mocked(request).mockImplementation(((_options: unknown, response: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => queueMicrotask(() => {
      attempts++;
      const socket = new EventEmitter(); req.emit("socket", socket);
      if (attempts === 1) {
        if (connected) socket.emit("secureConnect");
        req.emit("error", new Error("private upstream details"));
      } else response({ statusCode: 201, headers: {}, destroy() {} });
    });
    return req;
  }) as never);
  const send = createPushSender({ resolve: (async () => [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }]) as never });
  expect(await send(subscription(), "test", { ttl: 60, topic: "opaque" })).toEqual({ kind: connected ? "retry" : "accepted" });
  expect(attempts).toBe(connected ? 1 : 2);
});

it.each(["focused", "visible", "hidden"])("prefers the %s same-origin window when opening a notification", async preferred => {
  const listeners: Record<string, (event: unknown) => void> = {};
  const windows = ["hidden", "visible", "focused"].filter(kind => preferred === "focused" || kind !== "focused").filter(kind => preferred !== "hidden" || kind === "hidden")
    .map(kind => ({ url: "https://example.org/" + kind, focused: kind === "focused", visibilityState: kind === "hidden" ? "hidden" : "visible", navigate: vi.fn(async () => ({ focus: vi.fn() })) }));
  const foreign = { url: "https://other.example/", focused: true, navigate: vi.fn() };
  const self = { addEventListener: (kind: string, handler: (event: unknown) => void) => { listeners[kind] = handler; },
    clients: { matchAll: async () => [foreign, ...windows], openWindow: vi.fn() }, location: { origin: "https://example.org" } };
  vm.runInNewContext(fs.readFileSync("public/sw.js", "utf8"), { self, URL });
  let pending: Promise<unknown> | undefined;
  listeners.notificationclick({ notification: { close() {}, data: { url: "/notifications?push=1" } }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
  await pending;
  expect(windows.find(client => client.url.endsWith(preferred))!.navigate).toHaveBeenCalledOnce();
  for (const client of windows.filter(client => !client.url.endsWith(preferred))) expect(client.navigate).not.toHaveBeenCalled();
  expect(foreign.navigate).not.toHaveBeenCalled(); expect(self.clients.openWindow).not.toHaveBeenCalled();
});

it("bounds a push request and releases reconciliation waiters after an abort", async () => {
  const { beginPushChange, pushRequest, withPushReconciliation } = await import("~/lib/push/lifecycle.client");
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }))));
  const pending = withPushReconciliation(() => pushRequest("state", {}));
  const failure = expect(pending).rejects.toThrow("timeout");
  const change = beginPushChange();
  const run = vi.fn(async () => true); const waiting = withPushReconciliation(run);
  try {
    expect(timeout).toHaveBeenCalledTimes(1); expect(timeout.mock.calls[0][0]).toBeGreaterThan(0); expect(run).not.toHaveBeenCalled();
    controller.abort(); await failure; await change.ready;
  } finally { change.finish(); }
  expect(await waiting).toBe(true);
});

it("does not start I/O when a disposed lifecycle resumes after a change", async () => {
  const { beginPushChange, startPushLifecycle, withPushReconciliation } = await import("~/lib/push/lifecycle.client");
  const getRegistration = vi.fn(); const fetch = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ id: "browser", secret: "secret" }) });
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
  vi.stubGlobal("document", new EventTarget()); vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("fetch", fetch);
  const change = beginPushChange();
  const dispose = startPushLifecycle(); dispose(); change.finish();
  await withPushReconciliation(async () => {});
  expect(getRegistration).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Mobile Safari/537.36", "android"],
  ["Mozilla/5.0 (Linux; Android 14) SamsungBrowser/25.0 Chrome/123.0 Mobile Safari/537.36", "browser"],
  ["Mozilla/5.0 (Linux; Android 14) Chrome/123.0 Mobile Safari/537.36 EdgA/123.0", "browser"],
  ["Mozilla/5.0 (Linux; Android 14) UnknownBrowser/1.0", "browser"],
  ["Mozilla/5.0 (Android 14) Firefox/123.0", "firefox"],
  ["Mozilla/5.0 Windows Chrome/123.0 Safari/537.36 Edg/123.0", "edge"],
])("selects notification permission guidance for %s", (agent, expected) => {
  expect(pushRestoreBrowser(agent, false)).toBe(expected);
});
