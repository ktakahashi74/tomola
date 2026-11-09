// The uploader stays shared; an optional editor supplies the current receiver.
export type MediaEditor = { element: HTMLElement; insert: (url: string, alt: string) => void };
const editors = new WeakMap<HTMLTextAreaElement, MediaEditor>();
export function registerMediaEditor(field: HTMLTextAreaElement, editor: MediaEditor) {
  editors.set(field, editor);
  return () => { if (editors.get(field) === editor) editors.delete(field); };
}
export function mediaEditor(field: HTMLTextAreaElement) { return editors.get(field); }
