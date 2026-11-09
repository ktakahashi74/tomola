type Env = Record<string, string | undefined>;
export type ParsedPublicReading = { ok: true; enabled: boolean } | { ok: false; error: string };

// Read on each call so tests can change the setting without reloading modules.
export function parsePublicReading(raw: string | undefined): ParsedPublicReading {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "1") return { ok: true, enabled: value === "1" };
  return { ok: false, error: "PUBLIC_READING must be 1 or empty (unset)" };
}

export function publicReading(env: Env = process.env): boolean {
  const parsed = parsePublicReading(env.PUBLIC_READING);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.enabled;
}

export function readingHeaders(): Record<string, string> {
  return { "Cache-Control": "private", ...(publicReading() ? { "X-Robots-Tag": "noindex" } : {}) };
}
