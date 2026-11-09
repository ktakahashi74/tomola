import { localDraftKey, olderLocalDraftKey, orBlank, readLocalDraft, writeLocalDraft, removeLocalDraft, type DraftStore, type LocalDraft } from "./local-draft";
import { sameDraft } from "./set-aside-drafts";

let firstEntry = true;

function undelivered(record: LocalDraft): boolean {
  if (record.pending !== undefined) return record.pending;
  if (!record.server?.snapshot) return true;
  if (record.server.attempted && record.server.attempted !== record.server.snapshot) return true;
  try {
    const fields = new Map(JSON.parse(record.server.snapshot) as [string, string][]);
    return orBlank(record.title) !== (fields.get("title") ?? "") || record.body !== (fields.get("body") ?? "");
  } catch { return true; }
}

// The fixed device slot is a fallback for undelivered writing. Each history
// entry keeps its own complete copy in this tab, including acknowledged saves.
export function newPostDraftStore(owner: string, scope: string): DraftStore & { remember(): void } {
  const arrival = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  // An explicit visit to the same URL may retain history.state. Only reloads
  // and history traversal resume that document's editor; client-side history
  // entries already carry their own identity.
  const freshDocument = firstEntry && arrival?.type === "navigate" && arrival.name.split("#")[0] === window.location.href.split("#")[0];
  firstEntry = false;
  const remembered = !freshDocument && window.history.state?.draftEditorId;
  const editor = typeof remembered === "string" ? remembered : crypto.randomUUID();
  const remember = () => { try { window.history.replaceState({ ...window.history.state, draftEditorId: editor }, ""); } catch { /* The live form still keeps its link. */ } };
  // Initialization can run twice before another effect commits. Publish the
  // new identity now so both initializations select the same empty editor.
  remember();
  const key = localDraftKey(owner, scope);
  const tabKey = (name: string) => `${name}:${editor}`;
  let storage: Storage | undefined;
  try { storage = sessionStorage; } catch { /* Storage is optional. */ }
  const memory = new Map<string, LocalDraft>();
  // Set-aside records belong to the member and screen, across editors. Keep
  // them durable and read legacy slots live, rather than caching a tab copy.
  const aside = (name: string) => name.startsWith(olderLocalDraftKey(key));
  const read = (name: string) => aside(name) ? readLocalDraft(name) ?? (storage ? readLocalDraft(name, storage) : null) : memory.get(name) ?? (storage ? readLocalDraft(tabKey(name), storage) : null);
  const write = (name: string, value: LocalDraft) => { memory.set(name, value); return storage ? writeLocalDraft(tabKey(name), value, storage) : false; };
  const backup = readLocalDraft(key);
  if (!read(key) && backup && undelivered(backup)) {
      const recovered = { ...backup, editor };
      write(key, recovered);
      writeLocalDraft(key, recovered);
  }
  return {
    remember,
    read,
    // Earlier versions also kept single-slot set-asides in history entries.
    // Their exact session keys are now independently addressable, too.
    keys() {
      try { return Array.from({ length: storage?.length ?? 0 }, (_, i) => storage!.key(i)!).filter(name => name?.startsWith(`${olderLocalDraftKey(key)}:`)); }
      catch { return []; }
    },
    // Opening a set-aside consumes its source only after the device backup,
    // rather than merely the tab copy, is confirmed. It is now unsent writing.
    writeDurable(name, value) {
      const record = { ...value, pending: true, editor };
      if (!writeLocalDraft(name, record)) return false;
      write(name, record);
      return true;
    },
    write(name, value) {
      if (aside(name)) return writeLocalDraft(name, value);
      const before = read(name);
      const same = name === key && before?.base === value.base && before?.server?.id === value.server?.id && before?.server?.version === value.server?.version ? before : null;
      const record = { ...same, ...value, editor };
      if (value.pending === undefined && same && (same.body !== value.body || orBlank(same.title) !== orBlank(value.title))) record.pending = true;
      const written = write(name, record);
      const backup = readLocalDraft(name);
      if (undelivered(record) && (record.body.trim() || orBlank(record.title).trim())) {
        return writeLocalDraft(name, record) || written;
      }
      if (backup?.editor === editor) removeLocalDraft(name);
      return written;
    },
    remove(name) {
      if (aside(name)) {
        const saved = readLocalDraft(name), tab = storage ? readLocalDraft(name, storage) : null;
        removeLocalDraft(name);
        if (storage && tab && (!saved || sameDraft(saved, tab))) removeLocalDraft(name, storage);
        return;
      }
      const record = read(name);
      memory.delete(name);
      if (storage) removeLocalDraft(tabKey(name), storage);
      const backup = readLocalDraft(name);
      if (backup?.editor === editor || backup && !backup.editor && record?.body === backup.body && orBlank(record.title) === orBlank(backup.title)) removeLocalDraft(name);
    },
  };
}
