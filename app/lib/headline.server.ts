import { truncateGraphemes } from "./plain-text.core.server";
import { HEADLINE_CHARS } from "./headline.core.server";
import type * as core from "./headline.core.server";
import { markdownTask, canFallbackMarkdown } from "./markdown-budget.server";
export { HEADLINE_CHARS } from "./headline.core.server";

export function fallbackHeadline(...args: Parameters<typeof core.headlineFromBody>): ReturnType<typeof core.headlineFromBody> {
  return truncateGraphemes(args[0].slice(0, 4000).replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim(), args[1] ?? HEADLINE_CHARS, { trimEnd: true, maxUnits: Math.max(args[1] ?? HEADLINE_CHARS, HEADLINE_CHARS) * 4 });
}
export async function headlineFromBody(...args: Parameters<typeof core.headlineFromBody>): Promise<ReturnType<typeof core.headlineFromBody>> {
  try { return await markdownTask("headlineFromBody", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return fallbackHeadline(...args); }
}
