import { localDraftStore, olderLocalDraftKey, type DraftStore, type LocalDraft } from "./local-draft";

export type SetAsideDraft = { key: string; record: LocalDraft };

// Compare the complete displayed record, including its link and controls. A
// legacy slot may be replaced by an older tab while this tab shows its copy.
export function sameDraft(a: LocalDraft | null, b: LocalDraft): boolean {
  const values = (r: LocalDraft) => [r.title, r.body, r.base, r.savedAt, r.fields, r.pending, r.editor,
    r.server?.id, r.server?.version, r.server?.snapshot, r.server?.attempted];
  return a !== null && JSON.stringify(values(a)) === JSON.stringify(values(b));
}

export function setAsideDrafts(key: string, store: DraftStore = localDraftStore): SetAsideDraft[] {
  const legacy = olderLocalDraftKey(key);
  const keys = new Set([legacy, ...(store.keys?.() ?? []).filter(name => name.startsWith(`${legacy}:`))]);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (name?.startsWith(`${legacy}:`)) keys.add(name);
    }
  } catch { /* The legacy record may still be readable through the store. */ }
  return [...keys].flatMap(name => {
    const record = store.read(name);
    return record ? [{ key: name, record }] : [];
  }).sort((a, b) => b.record.savedAt - a.record.savedAt || a.key.localeCompare(b.key));
}

// Each addition owns a new key. Tabs never rewrite a shared list or evict an
// earlier entry. A successful write is read back before its source can go.
export function keepDraft(key: string, record: LocalDraft, store: DraftStore = localDraftStore): boolean {
  const name = `${olderLocalDraftKey(key)}:${crypto.randomUUID()}`;
  const written = store.write(name, record) && sameDraft(store.read(name), record);
  if (written) window.dispatchEvent?.(new Event("tomola:draft-set-aside"));
  return written;
}

export function removeShownDraft(shown: SetAsideDraft, store: DraftStore = localDraftStore) {
  if (sameDraft(store.read(shown.key), shown.record)) store.remove(shown.key);
}
