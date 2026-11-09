export type AutosavedDraft = { id: number; version: number; title: string | null; body: string; lang: string; asksStance: boolean; signingView: string; copied?: boolean };
export type AutosaveRequest = { pending?: Promise<AutosavedDraft | null>; leaving?: boolean };

// Writing tools and the departure guard share the writing surface's serialized save.
export function flushDraft(form: HTMLFormElement, leaving = false): Promise<AutosavedDraft | null> | undefined {
  const detail: AutosaveRequest = { leaving };
  form.dispatchEvent(new CustomEvent("tomola:autosave-flush", { detail }));
  return detail.pending;
}

export function draftIsDirty(form: HTMLFormElement): boolean | undefined {
  const detail: { dirty?: boolean } = {};
  form.dispatchEvent(new CustomEvent("tomola:autosave-dirty", { detail }));
  return detail.dirty;
}
