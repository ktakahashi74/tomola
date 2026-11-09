import type { MiddlewareFunction } from "react-router";

// Cover redirects from ancestor authentication loaders as well as page data and errors.
export const privateCacheMiddleware: MiddlewareFunction<Response> = async (_context, next) => {
  const response = await next();
  if (!(response instanceof Response)) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
