import type * as core from "./ai-visible-text.core.server";
import { canFallbackMarkdown, markdownTask } from "./markdown-budget.server";
export { visibleUnicode } from "./ai-visible-unicode.server";

export async function aiVisibleMarkdown(...args: Parameters<typeof core.aiVisibleMarkdown>): Promise<ReturnType<typeof core.aiVisibleMarkdown>> {
  try { return await markdownTask("aiVisibleMarkdown", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return { text: "", html: "" }; }
}
