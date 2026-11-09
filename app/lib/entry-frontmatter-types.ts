export const MAX_FRONTMATTER_LENGTH = 32 * 1024;
export type MappingResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: "invalid_frontmatter" | "frontmatter_not_object" };
