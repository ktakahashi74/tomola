// Handle rules preventing impersonation through visually similar names. Used by profile creation (app/lib/profiles.server.ts).

// Unique key: NFKC, lowercase, then NFKC again, because lowercasing can produce characters whose forms change under NFKC.
// Names differing only in case, full-/half-width forms, composed/combining characters, or compatibility characters (「ℂ」/「C」, 「①」/「1」) share a key.
// Store in profiles.handle_key with a unique index. Migration 0025 backfills existing rows with the corresponding SQL normalize/lower expression.
// Lowercase each character without context to match SQL lower. Whole-string toLowerCase() changes final sigma 「Σ」 to 「ς」
// and 「İ」 (U+0130) to 「i」 plus a combining dot, while PostgreSQL lower yields 「σ」/「i」. 「ΟΔΟΣ」 and 「οδοσ」 share a key.
export function handleKey(handle: string): string {
  const lower = Array.from(handle.normalize("NFKC"), (char) => (char === "\u0130" ? "i" : char.toLowerCase())).join("");
  return lower.normalize("NFKC");
}

// Reserved usernames are shared by registration and changes.
export const RESERVED_HANDLES = new Set([
  "admin", "administrator", "operator", "mod", "moderator", "staff", "official", "support", "help", "system", "root", "tomola", "api", "mcp", "ai", "nushi", "village-ai", "bot", "everyone", "all", "here", "me", "you", "anonymous", "deleted", "unknown", "null", "undefined",
]);
export const isReservedHandle = (handle: string): boolean => RESERVED_HANDLES.has(handle);
