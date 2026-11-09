import type { MiddlewareFunction } from "react-router";

const NAME = "tomola.logged-out";
export function hasLogoutNotice(request: Request): boolean {
  return (request.headers.get("cookie") ?? "").split(";").some(cookie => cookie.trim() === `${NAME}=1`);
}
export function logoutNoticeCookie(request: Request, show: boolean): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${NAME}=${show ? "1" : ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${show ? 60 : 0}${secure}`;
}

// Consume the flash on document and client-router responses, even when a child
// route provides its own headers. Path=/ also covers the router’s /login.data request.
export const logoutNoticeMiddleware: MiddlewareFunction = async ({ request }, next) => {
  const response = await next();
  if (request.method === "GET" && hasLogoutNotice(request) && response instanceof Response) {
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", logoutNoticeCookie(request, false));
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
};
