import type * as core from "./markdown.core.server";
import { cardPlainText } from "./card-excerpt.server";
import { markdownTask, MarkdownBudgetError, MarkdownBusyError, canFallbackMarkdown, isMarkdownWrite, withMarkdownScope } from "./markdown-budget.server";
export { RENDER_VERSION, CARD_MAX_BLOCKS, CARD_MAX_CHARS, mediaImage, type RenderOptions, type RenderedEntry } from "./markdown.core.server";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const plain = (text: string) => `<pre class="whitespace-pre-wrap">${escape(text)}</pre>`;
function plainEntry(text: string): core.RenderedEntry {
  const clipped = cardPlainText(text);
  return { html: plain(text), cardHtml: clipped === null ? null : plain(clipped), cardTruncated: clipped !== null };
}
export function renderMarkdown(...args: Parameters<typeof core.renderMarkdown>): Promise<string> {
  return markdownTask("renderMarkdown", args);
}
export function renderEntry(...args: Parameters<typeof core.renderEntry>): Promise<core.RenderedEntry> {
  return markdownTask("renderEntry", args);
}
export async function tryRenderMarkdown(...args: Parameters<typeof core.tryRenderMarkdown>): Promise<string | null> {
  try { return await markdownTask("tryRenderMarkdown", args); }
  catch (error) { if (!canFallbackMarkdown(error) || error instanceof MarkdownBusyError) throw error; return null; }
}
export async function tryRenderEntry(...args: Parameters<typeof core.tryRenderEntry>): Promise<core.RenderedEntry | null> {
  try { return await markdownTask("tryRenderEntry", args); }
  catch (error) { if (!canFallbackMarkdown(error) || error instanceof MarkdownBusyError) throw error; return null; }
}
export async function checkRenderable(markdown: string): Promise<boolean> { return await tryRenderMarkdown(markdown) !== null; }

// Admission precedes any extraction or DB side effect. Keep output-size refusal
// distinct from an exhausted CPU budget or a failed worker.
export async function checkBodyBudget(markdown: string, member?: string): Promise<"body_too_complex" | "body_unrenderable" | null> {
  const check = async () => {
    try {
      return await markdownTask<"body_unrenderable" | null>("admitMarkdown", [markdown]);
    } catch (error) {
      if (error instanceof MarkdownBudgetError) return "body_too_complex" as const;
      throw error;
    }
  };
  return member ? withMarkdownScope("write", member, check) : check();
}
export async function renderMarkdownOrPlain(...args: Parameters<typeof core.renderMarkdownOrPlain>): Promise<string> {
  return (await renderMarkdownResult(...args)).html;
}
export async function renderMarkdownResult(...args: Parameters<typeof core.renderMarkdownOrPlain>): Promise<core.RenderedEntry> {
  try {
    const html = await markdownTask<string | null>("tryRenderMarkdown", args);
    return { html: html ?? plain(args[0]), cardHtml: null, cardTruncated: false };
  } catch (error) {
    if (!canFallbackMarkdown(error)) throw error;
    return { html: plain(args[0]), cardHtml: null, cardTruncated: false, ...(error instanceof MarkdownBusyError ? { cacheable: false } : {}) };
  }
}
export async function renderEntryOrPlain(...args: Parameters<typeof core.renderEntryOrPlain>): Promise<core.RenderedEntry> {
  try { return await markdownTask<core.RenderedEntry | null>("tryRenderEntry", args) ?? plainEntry(args[0]); }
  catch (error) {
    if (!canFallbackMarkdown(error)) throw error;
    return { ...plainEntry(args[0]), ...(error instanceof MarkdownBusyError ? { cacheable: false } : {}) };
  }
}
