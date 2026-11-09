import { MAX_SOURCE_CHARS, truncateGraphemes } from "./plain-text.core.server";
import type * as core from "./plain-text.core.server";
import { markdownTask, canFallbackMarkdown } from "./markdown-budget.server";
export { MAX_SOURCE_CHARS, truncateGraphemes } from "./plain-text.core.server";

export async function markdownToPlainText(...args: Parameters<typeof core.markdownToPlainText>): Promise<ReturnType<typeof core.markdownToPlainText>> {
  try { return await markdownTask("markdownToPlainText", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return args[0].slice(0, MAX_SOURCE_CHARS).replace(/\s+/g, " ").trim(); }
}

export async function plainExcerpt(...args: Parameters<typeof core.plainExcerpt>): Promise<ReturnType<typeof core.plainExcerpt>> {
  try { return await markdownTask("plainExcerpt", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return truncateGraphemes(args[0].slice(0, MAX_SOURCE_CHARS).replace(/\s+/g, " ").trim(), args[1]); }
}

export async function firstBlockPlainText(...args: Parameters<typeof core.firstBlockPlainText>): Promise<ReturnType<typeof core.firstBlockPlainText>> {
  try { return await markdownTask("firstBlockPlainText", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return args[0].slice(0, MAX_SOURCE_CHARS).replace(/\s+/g, " ").trim(); }
}
