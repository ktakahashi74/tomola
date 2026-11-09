import { safeErrorText } from "~/lib/error-text.server";
import { isRouteErrorResponse } from "react-router";
import { redactUrl } from "../../../server/access-log.ts";

// Server error logging (handleError in app/entry.server.tsx). React Router defaults to console.error(error) for every error, which:
//   - Prints 「Error: No route matches URL "…"」 and a stack for every nonexistent URL (404) or wrong method (405). Mistyped URLs,
//     scanners, and bots flood logs. Messages also contain raw URLs; a mistyped `/invite/<token>` would leave a candidate token in logs.
//   - Does not identify the request causing the error.
// Here omit 404/405, whose status remains in access-log `[http]` lines. For other errors, attach the request using the access log's redactUrl function, hiding queries
// and `/invite/<token>`. Also redact the request's raw URL when present in the error message or stack.

// Errors omitted from logging: ErrorResponses for unmatched routes (404) and wrong methods (405). A 404 intentionally thrown by a route loader never reaches here
// because React Router does not pass ErrorResponses without `error` to handleError.
export function isQuietError(error: unknown): boolean {
  return isRouteErrorResponse(error) && (error.status === 404 || error.status === 405);
}

// Shape: 「GET /search?[redacted]」.
export function describeRequest(request: Request): string {
  const method = request.method.replace(/[^A-Za-z-]/g, "?").slice(0, 16);
  try {
    const url = new URL(request.url);
    return `${method} ${redactUrl(url.pathname + url.search)}`;
  } catch {
    return `${method} [unparsable URL]`;
  }
}

// Error wrapped by ErrorResponse: React Router's internal `error` property is absent from the declared type.
function innerError(error: unknown): unknown {
  if (!isRouteErrorResponse(error)) return error;
  return (error as { error?: unknown }).error ?? `${error.status} ${error.statusText}`;
}

function errorText(error: unknown): string {
  return safeErrorText(innerError(error), { stack: true });
}

// Redact this request's URL in messages, whether absolute or path/query.
function scrub(text: string, request: Request): string {
  let out = text;
  try {
    const url = new URL(request.url);
    const relative = url.pathname + url.search;
    const safe = redactUrl(relative);
    for (const raw of [url.href, relative]) if (raw.length > 1) out = out.split(raw).join(raw === url.href ? `${url.origin}${safe}` : safe);
  } catch {
    // Leave unparseable URLs unchanged; they are absent from the message too.
  }
  return out;
}

// Log line, or null when omitted.
export function formatErrorLog(error: unknown, request: Request): string | null {
  if (request.signal.aborted || isQuietError(error)) return null;
  return `[error] ${describeRequest(request)}\n${scrub(errorText(error), request)}`;
}

export function logServerError(error: unknown, request: Request): void {
  const line = formatErrorLog(error, request);
  if (line !== null) console.error(line);
}
