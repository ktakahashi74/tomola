import type { MiddlewareFunction } from "react-router";
import { safeLocalPath } from "~/lib/display-lang.server";
import { clearToggleSearch } from "~/lib/display";
import { publicReading } from "~/lib/public-reading.server";
import { getSessionUser } from "./session.server";

export function readingReturnCookieName(request: Request): string {
  return `${new URL(request.url).protocol === "https:" ? "__Host-" : ""}tomola.reading-return`;
}

function topicPath(raw: string): string | null {
  const url = new URL(safeLocalPath(raw), "http://tomola.invalid");
  return /^\/t\/\d+$/.test(url.pathname) ? `${url.pathname}${clearToggleSearch(url.search)}` : null;
}

function cookie(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${readingReturnCookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// Only a local topic location is remembered; no account or invitation data.
export function readReadingReturn(request: Request): string | null {
  const prefix = `${readingReturnCookieName(request)}=`;
  const found = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(prefix));
  if (found.length !== 1 || found[0].length > 2048) return null;
  try { return topicPath(decodeURIComponent(found[0].slice(prefix.length))); }
  catch { return null; }
}

export function clearReadingReturn(request: Request, headers: Headers): void {
  headers.append("Set-Cookie", cookie(request, "", 0));
}

// Covers document and client-router reads, after the Markdown twin middleware.
export const readingReturnMiddleware: MiddlewareFunction<Response> = async ({ request }, next) => {
  const response = await next();
  if (!publicReading() || request.method !== "GET" || !(response instanceof Response) || response.status !== 200) return response;
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/\.data$/, "");
  if (url.searchParams.has("_routes")) url.searchParams.delete("_routes");
  const path = topicPath(`${url.pathname}${url.search}`);
  if (path === null || await getSessionUser(request)) return response;
  const value = encodeURIComponent(path);
  if (`${readingReturnCookieName(request)}=${value}`.length > 2048) return response;
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie(request, value, 86400));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
