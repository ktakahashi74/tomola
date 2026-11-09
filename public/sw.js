// tomola service worker for home-screen installation and visible push notifications. Plain JavaScript without dependencies, registered by app/components/pwa-registration.tsx only in production builds.
//
// Cache only:
// - Hashed static /assets/ files (JavaScript, CSS, fonts): cache first. Their filename hash identifies content, which contains no member data.
// - /offline: public, script-free offline guidance identical for everyone (app/routes/offline.ts). Fetch without cookies when caching it (credentials: "omit").
// Never cache HTML documents (member data and per-request nonce), .data requests, .md twins, API, /mentions/suggest, /preview or anything else.
// Always fetch documents from the network; show offline guidance only when unreachable. Only the two explicit allowlist rules below may cache responses; leave everything else untouched.
// Visible push notifications use generic notice types and authenticated opening routes. No background synchronization.
// Notification payloads, subscription keys and member data never enter Cache Storage.
//
// The build injects its identity; activate removes old caches. See docs/deploy.md, "14. Adding to the home screen (PWA)".
const CACHE = "tomola-shell-__TOMOLA_BUILD_ID__";
const OFFLINE = "/offline";
// The shape of the built files (e.g. /assets/entry.client-DhRNr3QZ.js, /assets/KaTeX_Main-Bold-Cx986IdX.woff2). A test reads build/client/assets and checks
// that every built file matches this, so a change of Vite's naming cannot silently turn the caching off (e2e-prod/production.spec.ts).
const ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([new Request(OFFLINE, { cache: "reload", credentials: "omit" })]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.registration.navigationPreload?.enable())
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Document navigation always uses the network, never storage; show offline guidance only if unreachable.
  if (req.mode === "navigate") {
    event.respondWith(
      Promise.resolve(event.preloadResponse).catch(() => undefined).then(preload => preload || fetch(req)).catch(() =>
        caches
          .open(CACHE)
          .then((cache) => cache.match(OFFLINE, { ignoreVary: true }))
          .then((hit) => hit || Response.error()),
      ),
    );
    return;
  }

  // App shell: only hashed files directly under /assets/ (as Vite names them: <name>-<hash>.<ext>), with no query string, are served cache-first
  // (only a plain 200 of our own origin is stored). A query string is part of the cache key, so allowing one would let any page that links
  // /assets/x.js?n=1, ?n=2, ... fill the reader's Cache Storage with unlimited distinct entries. Anything else under /assets/ is left to the browser.
  if (url.search === "" && ASSET.test(url.pathname)) {
    event.respondWith(
      caches
        .open(CACHE)
        .then((cache) =>
          cache.match(req, { ignoreVary: true }).then(
            (hit) =>
              hit ||
              fetch(req).then((res) => {
                if (res.status === 200 && res.type === "basic") {
                  const copy = res.clone();
                  event.waitUntil(cache.put(req, copy));
                }
                return res;
              }),
          ),
        ),
    );
  }
  // For all other requests (.data, .md, API, /mentions/suggest, /preview, etc.), do not call respondWith; leave the browser's normal fetch unchanged.
});


self.addEventListener("push", event => {
  // A visible fallback is mandatory even for an empty or malformed payload.
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { /* Show the generic fallback. */ }
  const body = typeof payload.body === "string" && payload.body.length <= 512 ? payload.body : "tomola";
  const tag = typeof payload.tag === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(payload.tag) ? payload.tag : "tomola";
  const url = pushPath(payload.url);
  event.waitUntil(self.registration.showNotification("tomola", { body, tag, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", data: { url } }));
});

function pushPath(value) {
  if (typeof value !== "string" || value.length > 512) return "/notifications";
  // Only server-authenticated notification links or the test's settings anchor.
  if (/^\/notifications\/[1-9]\d*\/open\?push=[1-9]\d*$/.test(value) || /^\/notifications\?push=[1-9]\d*$/.test(value) || value === "/settings#settings-push") return value;
  return "/notifications";
}
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(pushPath(event.notification.data?.url), self.location.origin).href;
  // A normal navigation rechecks session, recipient and current read permissions.
  // Never send the payload to an existing page or cache the navigation response.
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const local = windows.filter(client => new URL(client.url).origin === self.location.origin);
    const priority = client => client.focused ? 2 : client.visibilityState === "visible" ? 1 : 0;
    local.sort((a, b) => priority(b) - priority(a));
    for (const client of local) {
      try {
        const navigated = await client.navigate(url);
        if (navigated) { await navigated.focus(); return; }
      } catch { /* An uncontrolled/closing window may not be navigable. */ }
    }
    await self.clients.openWindow(url);
  })());
});
