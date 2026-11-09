import type * as core from "./site-export-format.core.server";
import { markdownTask, canFallbackMarkdown } from "./markdown-budget.server";
export { escapeHtml, relativeFile, exportHref, offlineHtml, EXPORT_CSS, type ExportLinks } from "./site-export-format.core.server";

export async function referencedMedia(...args: Parameters<typeof core.referencedMedia>): Promise<ReturnType<typeof core.referencedMedia>> {
  try { return await markdownTask("referencedMedia", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return []; }
}

export async function offlineMarkdown(...args: Parameters<typeof core.offlineMarkdown>): Promise<ReturnType<typeof core.offlineMarkdown>> {
  try { return await markdownTask("offlineMarkdown", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return literalMarkdown(args[0]); }
}

// A stopped operation must not expose active HTML or images to an offline reader.
function literalMarkdown(source: string): string {
  let longest = 2;
  for (const run of source.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${source}\n${fence}\n`;
}
