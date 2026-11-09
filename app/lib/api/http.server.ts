import { messageOf } from "~/lib/draft-errors.server";
import { safeErrorText } from "~/lib/error-text.server";
import { MarkdownBudgetError } from "~/lib/markdown-budget.server";
import type { RateLimitResult } from "~/lib/rate-limit.server";
import { rateLimitHeaders } from "~/lib/rate-limit.server";

// Helpers for Markdown and JSON read responses. Responses containing member content must stay out of shared caches and search engines.

export type Format = "text" | "json";

// Read Authorization: Bearer <token> and provide the 401 WWW-Authenticate header (RFC 6750).
export const BEARER_PATTERN = /^Bearer[ \t]+(\S+)[ \t]*$/i;
export function bearerChallenge(error?: string): Record<string, string> {
  return { "WWW-Authenticate": error ? `Bearer realm="tomola", error="${error}"` : 'Bearer realm="tomola"' };
}

// Headers for responses containing member content. Referrer-Policy and X-Robots-Tag prevent a token in the URL's k parameter
// from leaking through referrers or appearing in search results (also set for session-authenticated reads).
export const MEMBER_CONTENT_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  Vary: "Authorization, Cookie",
};

const TYPES: Record<Format, string> = { text: "text/plain; charset=utf-8", json: "application/json; charset=utf-8" };

// Build the response. HEAD has no body, with the same headers.
export function memberResponse(
  request: Request,
  body: string,
  opts: { format?: Format; status?: number; headers?: Record<string, string>; rate?: RateLimitResult | null } = {},
): Response {
  const headers: Record<string, string> = {
    "Content-Type": TYPES[opts.format ?? "text"],
    ...MEMBER_CONTENT_HEADERS,
    ...(opts.rate ? rateLimitHeaders(opts.rate) : {}),
    ...opts.headers,
  };
  return new Response(request.method === "HEAD" ? null : body, { status: opts.status ?? 200, headers });
}

// Machine-readable errors: text contains "<status>: <code>" and an explanation; JSON contains { error, message }.
export function errorResponse(
  request: Request,
  format: Format,
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const body = format === "json" ? JSON.stringify({ error: code, message }) : `${status} ${code}\n\n${message}\n`;
  return memberResponse(request, body, { format, status, headers: extraHeaders });
}

export function methodNotAllowed(request: Request, format: Format, allow: string): Response {
  return errorResponse(request, format, 405, "method_not_allowed", `Use ${allow}.`, { Allow: allow });
}

export function notFound(request: Request, format: Format): Response {
  return errorResponse(request, format, 404, "not_found", "Not found.");
}

// Public guidance (/llms.txt, etc.). It contains no member content and may be cached.
export function publicResponse(request: Request, body: string, contentType: string): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// When an unexpected exception occurs while handling a machine-readable response (Markdown, changes feed, or manifest), return
// a text 500 response (JSON for the JSON format), rather than an HTML error page. Log the exception on the server, without exposing it in the response.
export async function guarded(request: Request, format: Format, label: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MarkdownBudgetError) return errorResponse(request, format, 400, "body_too_complex", messageOf("body_too_complex"));
    if (error instanceof Error && "status" in error && error.status === 503) return errorResponse(request, format, 503, "busy", "Processing is busy. Try again shortly.", { "Retry-After": "1" });
    console.error(`[${label}] unexpected error for ${request.method} ${new URL(request.url).pathname}:`, safeErrorText(error));
    return errorResponse(request, format, 500, "internal", "Internal error. Try again later.");
  }
}
