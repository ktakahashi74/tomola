// Headers for non-HTML static responses such as /assets and /llms.txt (server.ts). The app adds headers to HTML and API responses itself (app/lib/http/security-headers.server.ts).
// Static files receive only nosniff and production HSTS. CSP, Referrer-Policy and Permissions-Policy apply to HTML documents and are not added here.
// Exception: the response of the service worker script (/sw.js) carries the worker's own CSP, default-src 'self' (setStaticHeaders below).
// Production uses the same predicate as the app: not isDevOrTest, meaning NODE_ENV is neither development nor test. Unset and staging count as production; this is not NODE_ENV === "production".
import path from "node:path";
import { isDevOrTest } from "../app/lib/env.server.ts";

export const STATIC_HSTS = "max-age=31536000";

export function staticSecurityHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    ...(isDevOrTest(env) ? {} : { "Strict-Transport-Security": STATIC_HSTS }),
  };
}

// Files requiring revalidation instead of long caching: the service worker, so updates are not delayed by the one-hour static cache, and its manifest.
// Conditional ETag requests avoid resending unchanged bodies. Keys are paths inside build/client, the static directory.
export const REVALIDATED_STATIC_PATHS: ReadonlySet<string> = new Set(["/sw.js", "/manifest.webmanifest"]);
export const REVALIDATED_CACHE_CONTROL = "no-cache";
export const SERVICE_WORKER_PATH = "/sw.js";
export const SERVICE_WORKER_CSP = "default-src 'self'";

// Body of express.static setHeaders in server.ts. file is the absolute path of the file being served. Add nosniff and HSTS; override Cache-Control with no-cache for revalidated files
// because setHeaders runs before express.static assigns its defaults, which do not overwrite existing headers.
export function setStaticHeaders(
  res: { setHeader(name: string, value: string): unknown },
  clientDir: string,
  file: string,
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [name, value] of Object.entries(staticSecurityHeaders(env))) res.setHeader(name, value);
  const urlPath = `/${path.relative(clientDir, file).split(path.sep).join("/")}`;
  if (REVALIDATED_STATIC_PATHS.has(urlPath)) res.setHeader("Cache-Control", REVALIDATED_CACHE_CONTROL);
  // The response of a worker script carries the CSP of the worker itself. The service worker only talks to its own origin, so this is all it may do.
  if (urlPath === SERVICE_WORKER_PATH) res.setHeader("Content-Security-Policy", SERVICE_WORKER_CSP);
}
