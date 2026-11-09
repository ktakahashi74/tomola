import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareFunction } from "react-router";

// Better Auth's getSession returns Set-Cookie when refreshing a session (extending its expiry on the first call at least one day after the last refresh)
// or deleting an invalid cookie. The app calls getSession repeatedly within a request, such as in layout and page loaders,
// so collect only the last cookie per name in request-local storage (AsyncLocalStorage), and let root middleware attach them to the response.
// This keeps active members' sessions from expiring after the default seven days and avoids duplicate cookies in responses.
// If the response already contains a cookie of the same name (a new session at login or deletion at logout), prefer the response's cookie
// so refreshing an old session cannot overwrite the new session cookie.
const store = new AsyncLocalStorage<Map<string, string>>();

const cookieName = (setCookie: string) => setCookie.slice(0, setCookie.indexOf("=")).trim();

// Collect Set-Cookie from getSession's returned headers in the current request's storage. Do nothing without storage (outside middleware, such as in tests).
export function collectSessionCookies(headers: Headers): void {
  const cookies = store.getStore();
  if (!cookies) return;
  for (const setCookie of headers.getSetCookie()) cookies.set(cookieName(setCookie), setCookie);
}

function withCookies(response: Response, cookies: Map<string, string>): Response {
  const own = new Set(response.headers.getSetCookie().map(cookieName));
  const extra = [...cookies].filter(([name]) => !own.has(name)).map(([, setCookie]) => setCookie);
  if (extra.length === 0) return response;
  try {
    for (const setCookie of extra) response.headers.append("Set-Cookie", setCookie);
    return response;
  } catch {
    // Immutable headers (fetch responses or Response.redirect): copy into a new Response.
    const headers = new Headers(response.headers);
    for (const setCookie of extra) headers.append("Set-Cookie", setCookie);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

// Root middleware also covers data requests (.data) and resource routes, since all are handled under the root.
export const sessionCookieMiddleware: MiddlewareFunction = async (_args, next) => {
  const cookies = new Map<string, string>();
  const response = await store.run(cookies, () => next());
  // On the server, next() returns a Response (typed as unknown).
  return response instanceof Response ? withCookies(response, cookies) : response;
};
