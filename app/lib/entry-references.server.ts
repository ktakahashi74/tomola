import type * as core from "./entry-references.core.server";
import { markdownTask, canFallbackMarkdown } from "./markdown-budget.server";
export { type ReferenceTarget } from "./entry-references.core.server";

export async function parseEntryReferences(...args: Parameters<typeof core.parseEntryReferences>): Promise<ReturnType<typeof core.parseEntryReferences>> {
  try { return await markdownTask("parseEntryReferences", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return []; }
}
