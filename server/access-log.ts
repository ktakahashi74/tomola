// Access logging for production server.ts: omit URL components that may contain secrets:
// - Redact the whole query string as ?[redacted], including ?k= (read tokens and signed "AIで開く" links), ?q= (search text), /auth/confirm?token= (login tokens),
// and ?cursor=. Omit parameter names as well as values: new features change which names are secret, so keep no name allowlist.
// - Replace /invite/<token> with /invite/[redacted]. Invitation tokens are path components. Match React Router routing rules: case-insensitive,
// percent-decoded, repeated slashes collapsed, and dot segments resolved (/./invite/..., /x/../invite/..., /%2e%2e/invite/...) before inspecting the path
// using standard URL rules: new URL(path, base).pathname.
// Replace control characters with ? and truncate long URLs to prevent log-line injection and excessive log size.
// Avoid the app alias ~/ and use only erasable TypeScript syntax so Node can read this file directly.

export const REDACTED = "[redacted]";
const MAX_LOGGED_PATH = 200;

function decodedPath(pathname: string): string {
  let decoded = pathname;
  // Handle double-encoded paths such as %2569nvite too; stop when decoding fails.
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  const flat = `/${decoded.replace(/\\/g, "/").replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  try {
    // Resolve dot segments using standard URL rules: the router treats /x/../invite/t as /invite/t. Treat ? and # exposed by decoding as path characters.
    const resolved = new URL(flat.replace(/\?/g, "%3F").replace(/#/g, "%23"), "http://x").pathname;
    return decodeURIComponentSafe(resolved).replace(/\/{2,}/g, "/").toLowerCase();
  } catch {
    return flat.toLowerCase();
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Redact credentials and article identifiers on counted reading paths. Logs
// must not become a separate per-article record of reading notifications.
function secretPathPrefix(pathname: string): string | null {
  const path = decodedPath(pathname);
  if (/^\/t\/[1-9]\d*(?:\.(?:md|txt|data))?(?:\/translations)?\/?$/.test(path)) return "/t/";
  if (path === "/media" || path.startsWith("/media/")) return "/media/";
  if (path === "/invite" || path.startsWith("/invite/")) return "/invite/";
  return null;
}

// Turn a request URL (path and query, like req.originalUrl) into a safe log representation.
export function redactUrl(rawUrl: string): string {
  const queryAt = rawUrl.indexOf("?");
  const hashAt = rawUrl.indexOf("#");
  const end = queryAt >= 0 ? queryAt : hashAt >= 0 ? hashAt : rawUrl.length;
  const pathname = rawUrl.slice(0, end);
  const hasQuery = queryAt >= 0;
  const hidden = secretPathPrefix(pathname);
  const path = hidden !== null ? `${hidden}${REDACTED}` : pathname;
  const safe = path.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
  return `${safe.length > MAX_LOGGED_PATH ? `${safe.slice(0, MAX_LOGGED_PATH)}…` : safe}${hasQuery ? `?${REDACTED}` : ""}`;
}

export type AccessLogEntry = { method: string; url: string; status: number; bytes: number | null; ms: number };

// One line close to morgan tiny format: GET /search?[redacted] 200 1234 - 12.345 ms.
export function formatAccessLog(entry: AccessLogEntry): string {
  const method = entry.method.replace(/[^A-Za-z-]/g, "?").slice(0, 16);
  return `[http] ${method} ${redactUrl(entry.url)} ${entry.status} ${entry.bytes ?? "-"} - ${entry.ms.toFixed(3)} ms`;
}
