import { parseDocument } from "yaml";
import { MAX_FRONTMATTER_LENGTH, type MappingResult } from "./entry-frontmatter-types";

export function parseMapping(raw: string): MappingResult {
  if (raw.length > MAX_FRONTMATTER_LENGTH) return { ok: false, error: "invalid_frontmatter" };
  try {
    const doc = parseDocument(raw, { schema: "core", uniqueKeys: true });
    if (doc.errors.length > 0) return { ok: false, error: "invalid_frontmatter" };
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (value === null || value === undefined) return { ok: true, data: {} };
    if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "frontmatter_not_object" };
    return { ok: true, data: value as Record<string, unknown> };
  } catch {
    // Parsing failed, for example because nesting was too deep.
    return { ok: false, error: "invalid_frontmatter" };
  }
}
