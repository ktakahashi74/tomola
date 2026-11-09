import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseOf, clearLocalDrafts, draftStoreForOwner, localDraftKey, localDraftStore, olderLocalDraftKey, readLocalDraft, removeLocalDraftFamily, writeLocalDraft, type LocalDraft } from "../app/lib/local-draft";
import { keepDraft, removeShownDraft, setAsideDrafts } from "../app/lib/set-aside-drafts";
import { newPostDraftStore } from "../app/lib/new-post-draft";

const key = localDraftKey("writer", "reply:1:");
const record: LocalDraft = { title: "Title", body: "Unsent writing", base: baseOf("old", "base"), savedAt: 1,
  fields: '[["lang","ja"],["stanceTag","objection"]]', pending: true, editor: "source-editor",
  server: { id: 12, version: 3, snapshot: "saved", attempted: "unsaved" } };

function storage(): Storage {
  const entries = new Map<string, string>();
  return { get length() { return entries.size; }, key: i => [...entries.keys()][i] ?? null,
    getItem: name => entries.get(name) ?? null, setItem: (name, value) => { entries.set(name, value); },
    removeItem: name => { entries.delete(name); }, clear: () => entries.clear() };
}
beforeEach(() => {
  const local = storage(), session = storage();
  vi.stubGlobal("localStorage", local); vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("window", { localStorage: local, sessionStorage: session, history: { state: {}, replaceState(value: object) { this.state = value; } }, location: { href: "http://localhost/t/new" } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps every record and all recovery metadata under independent keys without changing the legacy slot", () => {
  writeLocalDraft(olderLocalDraftKey(key), record);
  expect(keepDraft(key, { ...record, body: "Second" })).toBe(true);
  expect(keepDraft(key, { ...record, body: "Third" })).toBe(true);
  const entries = setAsideDrafts(key);
  expect(new Set(entries.map(item => item.key)).size).toBe(3);
  expect(entries.map(item => item.record.body).sort()).toEqual(["Second", "Third", record.body].sort());
  for (const item of entries) expect({ ...item.record, body: record.body }).toEqual(record);
  expect(readLocalDraft(olderLocalDraftKey(key))).toEqual(record);
});

it("offers the newest set-aside first across independent and legacy records", () => {
  writeLocalDraft(olderLocalDraftKey(key), { ...record, body: "Legacy", savedAt: 2000 });
  keepDraft(key, { ...record, body: "Oldest", savedAt: 1000 });
  keepDraft(key, { ...record, body: "Newest", savedAt: 3000 });
  expect(setAsideDrafts(key).map(item => item.record.body)).toEqual(["Newest", "Legacy", "Oldest"]);
});

it("two stores adding after the same enumeration cannot lose each other's additions", () => {
  const first = draftStoreForOwner("writer", localDraftStore), second = draftStoreForOwner("writer", localDraftStore);
  expect(setAsideDrafts(key, first)).toEqual([]);
  expect(setAsideDrafts(key, second)).toEqual([]);
  expect(keepDraft(key, record, first)).toBe(true);
  expect(keepDraft(key, { ...record, body: "Other tab" }, second)).toBe(true);
  expect(setAsideDrafts(key).map(item => item.record.body).sort()).toEqual(["Other tab", record.body].sort());
});

it("a displayed snapshot cannot delete a legacy replacement, even with the same timestamp and body", () => {
  writeLocalDraft(olderLocalDraftKey(key), record);
  const [shown] = setAsideDrafts(key);
  const replacement = { ...record, server: { ...record.server!, version: 4 } };
  writeLocalDraft(shown.key, replacement);
  removeShownDraft(shown);
  expect(readLocalDraft(shown.key)).toEqual(replacement);
  removeShownDraft({ key: shown.key, record: replacement });
  expect(readLocalDraft(shown.key)).toBeNull();
});

it("removes just the displayed independent record", () => {
  keepDraft(key, record); keepDraft(key, { ...record, body: "Keep me" });
  const entries = setAsideDrafts(key);
  removeShownDraft(entries.find(item => item.record.body === record.body)!);
  expect(setAsideDrafts(key).map(item => item.record.body)).toEqual(["Keep me"]);
});

it("reports quota failure and an unconfirmed write while retaining the source and legacy record", () => {
  writeLocalDraft(key, record); writeLocalDraft(olderLocalDraftKey(key), record);
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
  expect(keepDraft(key, record)).toBe(false);
  expect(readLocalDraft(key)).toEqual(record);
  expect(setAsideDrafts(key).map(item => item.record)).toEqual([record]);
  expect(keepDraft(key, record, { ...localDraftStore, write: () => true, read: () => null })).toBe(false);
});

it("new-post set-asides survive closing the tab, including acknowledged metadata, without tab caching", () => {
  const scope = "topic-new:::";
  const screen = localDraftKey("writer", scope), store = newPostDraftStore("writer", scope);
  expect(keepDraft(screen, { ...record, pending: false }, store)).toBe(true);
  sessionStorage.clear();
  const next = newPostDraftStore("writer", scope);
  expect(setAsideDrafts(screen, next).map(item => item.record)).toEqual([{ ...record, pending: false }]);
  writeLocalDraft(olderLocalDraftKey(screen), record);
  const shown = setAsideDrafts(screen, next).find(item => item.key === olderLocalDraftKey(screen))!;
  writeLocalDraft(shown.key, { ...record, body: "Replacement" });
  expect(next.read(shown.key)?.body).toBe("Replacement");
});

it("new-post set-asides require durable local storage, even when tab storage still works", () => {
  const store = newPostDraftStore("writer", "topic-new:::");
  const screen = localDraftKey("writer", "topic-new:::");
  store.write(screen, record);
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Full"); });
  expect(keepDraft(localDraftKey("writer", "topic-new:::"), record, store)).toBe(false);
  expect(store.writeDurable?.(screen, { ...record, body: "Unconfirmed replacement" })).toBe(false);
  expect(store.read(screen)?.body).toBe(record.body);
});

it("reads and consumes legacy history-entry set-asides without hiding the independent local records", () => {
  const screen = localDraftKey("writer", "topic-new:::"), legacy = olderLocalDraftKey(screen);
  const tab = `${legacy}:previous-editor`;
  writeLocalDraft(legacy, record);
  writeLocalDraft(tab, { ...record, body: "Legacy history entry" }, sessionStorage);
  const store = draftStoreForOwner("writer", newPostDraftStore("writer", "topic-new:::"));
  const entries = setAsideDrafts(screen, store);
  expect(entries.map(item => item.record.body).sort()).toEqual([record.body, "Legacy history entry"].sort());
  removeShownDraft(entries.find(item => item.key === tab)!, store);
  expect(sessionStorage.getItem(tab)).toBeNull();
  expect(readLocalDraft(legacy)).toEqual(record);
});

it("logout clears legacy, independent and session records and invalidates delayed archive operations", () => {
  const owned = draftStoreForOwner("writer", localDraftStore);
  keepDraft(key, record, owned); writeLocalDraft(olderLocalDraftKey(key), record);
  writeLocalDraft(`${key}~older:tab`, record, sessionStorage);
  clearLocalDrafts();
  expect(setAsideDrafts(key)).toEqual([]);
  expect(sessionStorage.length).toBe(0);
  expect(keepDraft(key, record, owned)).toBe(false);
});

it("isolates owners and preserves the existing reply-family deletion boundary", () => {
  const other = localDraftKey("other", "reply:1:"), anotherThread = localDraftKey("writer", "reply:2:");
  keepDraft(key, record); keepDraft(`${key}42`, record); keepDraft(other, record); keepDraft(anotherThread, record);
  const owned = draftStoreForOwner("writer", localDraftStore);
  expect(setAsideDrafts(other, owned)).toEqual([]);
  expect(keepDraft(other, record, owned)).toBe(false);
  removeLocalDraftFamily("writer", "reply:1:");
  expect(setAsideDrafts(key)).toEqual([]);
  expect(setAsideDrafts(`${key}42`)).toEqual([]);
  expect(setAsideDrafts(other)).toHaveLength(1);
  expect(setAsideDrafts(anotherThread)).toHaveLength(1);
});
