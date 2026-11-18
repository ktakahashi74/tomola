import { startsWithFrontmatter } from "./text";

export const EDITOR_MODE_STORAGE_KEY = "tomola:editor-mode";
export const EDITOR_BODY_REPLACED_EVENT = "tomola:body-replaced";
export const EDITOR_STRINGIFY_OPTIONS = { bullet: "-", emphasis: "*", rule: "-" } as const;

export function prefersRichEditor(preference: string | null): boolean {
  return preference !== "markdown";
}

// A literal dollar is deliberately treated conservatively: formulas must never
// pass through a Markdown serializer without a math-aware editor.
export function requiresMarkdownEditor(body: string): boolean {
  return body.includes("$") || startsWithFrontmatter(body);
}

// Normalization is allowed only after a document edit. Comparing with the first
// serialization also restores the exact source when edits are undone.
export function preserveEditorSource(source: string, initial: string, current: string): string {
  return initial === current ? source : current;
}

// Notify native and React input listeners, including mentions and the existing preview.
export function replaceEditorBody(textarea: HTMLTextAreaElement, body: string) {
  textarea.value = body;
  textarea.dispatchEvent(new Event(EDITOR_BODY_REPLACED_EVENT));
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}
