// The device copy is kept per member and screen. Writing screens may also remember their server draft here.
// A record carries `base`, a hash of the text the screen started from, so that a record is restored only onto the same starting text.
export const LOCAL_DRAFT_PREFIX = "tomola:draft:";
export const LOCAL_DRAFT_RECOVERY_KEY = `${LOCAL_DRAFT_PREFIX}recovery`;


// The member whose writing screens this tab last showed: the error screen does not know who is reading, and must not speak of another member's writing on a shared device.
const OWNER_KEY = "tomola:draft-owner";
const GENERATION_KEY = "tomola:writing-generation";

export type ServerDraftLink = { id: number; version: number; snapshot?: string; attempted?: string };
export type LocalDraft = { title?: string; body: string; base: string; savedAt: number; server?: ServerDraftLink; fields?: string; pending?: boolean; editor?: string };
export type DraftStore = { read(key: string): LocalDraft | null; write(key: string, value: LocalDraft): boolean; writeDurable?(key: string, value: LocalDraft): boolean; keys?(): string[]; remove(key: string): void };

export function localDraftKey(owner: string, scope: string): string {
  return `${LOCAL_DRAFT_PREFIX}${owner}:${scope}`;
}

// A short, stable fingerprint. It is not a security measure; it only tells two starting texts apart.
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length}.${hash.toString(36)}`;
}

// A missing text is the empty text here: this is only the fingerprint of what the screen starts from, nothing that is stored or shown.
export function orBlank(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : value;
}

export function baseOf(title: string | null | undefined, body: string): string {
  return hashText(`${orBlank(title)}\u0000${body}`);
}

export function readLocalDraft(key: string, storage?: Storage): LocalDraft | null {
  try {
    const raw = (storage ?? localStorage).getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<LocalDraft>;
    if (typeof value.body !== "string" || typeof value.base !== "string" || typeof value.savedAt !== "number") return null;
    const server = value.server;
    return { body: value.body, base: value.base, savedAt: value.savedAt, ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(server && Number.isSafeInteger(server.id) && server.id > 0 && Number.isSafeInteger(server.version) && server.version > 0 ? { server } : {}),
      ...(typeof value.fields === "string" ? { fields: value.fields } : {}),
      ...(typeof value.pending === "boolean" ? { pending: value.pending } : {}),
      ...(typeof value.editor === "string" ? { editor: value.editor } : {}) };
  } catch { return null; }
}

export function writeLocalDraft(key: string, value: LocalDraft, storage?: Storage): boolean {
  try { (storage ?? localStorage).setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export function removeLocalDraft(key: string, storage?: Storage) {
  try { (storage ?? localStorage).removeItem(key); } catch { /* Storage is optional. */ }
}

export const localDraftStore: DraftStore = { read: readLocalDraft, write: writeLocalDraft, remove: removeLocalDraft };

// An editor keeps its generation for its whole lifetime. Reading storage on
// every operation also rejects delayed callbacks before a storage event arrives.
export function draftStoreForOwner(owner: string, store: DraftStore) {
  const generation = () => { try { return localStorage.getItem(GENERATION_KEY); } catch { return null; } };
  const initial = generation();
  const active = () => generation() === initial;
  const owns = (key: string) => active() && key.startsWith(localDraftKey(owner, ""));
  return {
    active,
    read: (key: string) => owns(key) ? store.read(key) : null,
    write: (key: string, value: LocalDraft) => owns(key) && store.write(key, value),
    keys: () => store.keys?.().filter(owns) ?? [],
    remove: (key: string) => { if (owns(key)) store.remove(key); },
  };
}

// Called on logout, so that the next person at a shared device does not see unsent writing.
export function clearLocalDrafts() {
  try { localStorage.setItem(GENERATION_KEY, crypto.randomUUID()); } catch { /* Storage is optional. */ }
  window.dispatchEvent?.(new Event("tomola:drafts-cleared"));
  try { sessionStorage.removeItem(OWNER_KEY); sessionStorage.removeItem(LOCAL_DRAFT_RECOVERY_KEY); } catch { /* Storage is optional. */ }
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[name];
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith(LOCAL_DRAFT_PREFIX)) storage.removeItem(key);
      }
    } catch { /* Storage is optional. */ }
  }
}

// The scope that the writing screen at this address keeps its record under (see localDraftKey), or null for an address that is not a writing screen.
function scopeOfPath(pathname: string): string | null {
  const match = /^\/(?:t\/(new)|t\/(\d+)(\/edit)?|c\/(\d+)\/edit|drafts\/(\d+))\/?$/.exec(pathname);
  if (!match) return null;
  if (match[1]) return "topic-new";
  if (match[2]) return match[3] ? `edit:topic:${match[2]}` : `reply:${match[2]}`;
  return match[4] ? `edit:reply:${match[4]}` : `draft:${match[5]}`;
}

export function rememberDraftOwner(owner: string) {
  try { sessionStorage.setItem(OWNER_KEY, owner); } catch { /* Storage is optional. */ }
}

// Whether this device holds unsent writing of the member of this tab for the writing screen at this address (a set-aside record counts too).
export function hasLocalDraftAt(pathname: string): boolean {
  const scope = scopeOfPath(pathname);
  if (!scope) return false;
  try {
    const owner = sessionStorage.getItem(OWNER_KEY);
    if (!owner) return false;
    const front = `${LOCAL_DRAFT_PREFIX}${owner}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(front)) continue;
      const own = key.slice(front.length);
      if (own === scope || own.startsWith(`${scope}:`) || own.startsWith(`${scope}~`)) return true;
    }
  } catch { /* Storage is optional. */ }
  return false;
}

// A record that was set aside when the text it was made on changed (see DraftKeeper): offered on each visit to the screen until it is opened or discarded.
export function olderLocalDraftKey(key: string): string {
  return `${key}~older`;
}

// Every record of one screen family (the reply field of one thread keeps one record per reply target): used when what was typed is sent or discarded.
export function removeLocalDraftFamily(owner: string, family: string) {
  const prefix = localDraftKey(owner, family);
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch { /* Storage is optional. */ }
}
