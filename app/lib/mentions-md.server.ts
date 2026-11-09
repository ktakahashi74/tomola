import type * as core from "./mentions-md.core.server";
import { markdownTask, canFallbackMarkdown } from "./markdown-budget.server";
export { frozenMentionKey, MAX_MENTION_CANDIDATES, splitMentions, type MentionTarget, type MentionTargets, type MentionPiece, type MentionMatch } from "./mentions-md.core.server";

export async function mentionTokens(...args: Parameters<typeof core.mentionTokens>): Promise<ReturnType<typeof core.mentionTokens>> {
  try { return await markdownTask("mentionTokens", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return []; }
}

export async function mentionSpellings(...args: Parameters<typeof core.mentionSpellings>): Promise<ReturnType<typeof core.mentionSpellings>> {
  try { return await markdownTask("mentionSpellings", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return []; }
}

export async function matchMentions(...args: Parameters<typeof core.matchMentions>): Promise<ReturnType<typeof core.matchMentions>> {
  try { return await markdownTask("matchMentions", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return []; }
}

export async function sourceTargets(...args: Parameters<typeof core.sourceTargets>): Promise<ReturnType<typeof core.sourceTargets>> {
  try { return await markdownTask("sourceTargets", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return new Map(); }
}
