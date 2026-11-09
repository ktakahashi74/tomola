import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseOf, clearLocalDrafts, draftStoreForOwner, localDraftStore, localDraftKey, olderLocalDraftKey, readLocalDraft, writeLocalDraft, type LocalDraft } from "../app/lib/local-draft";
import { newPostDraftStore } from "../app/lib/new-post-draft";

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return { get length() { return entries.size; }, key: i => [...entries.keys()][i] ?? null,
    getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); }, clear: () => entries.clear() };
}
const key = localDraftKey("writer", "topic-new:::");
function record(body: string, pending: boolean, id = 1): LocalDraft {
  return { body, base: baseOf("", ""), savedAt: 1, pending,
    server: { id, version: 1, snapshot: JSON.stringify([["body", "Saved text"]]) } };
}
function fresh() { window.history.replaceState({}, ""); const store = newPostDraftStore("writer", "topic-new:::"); store.remember(); return store; }
beforeEach(() => {
  const local = memoryStorage(), session = memoryStorage();
  const history = { state: {}, replaceState(value: object) { this.state = value; } };
  vi.stubGlobal("localStorage", local); vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("window", { history, location: { href: "http://localhost/t/new" }, localStorage: local, sessionStorage: session });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps acknowledged writing for reload and back, while a fresh visit starts empty", () => {
  const first = fresh(), entry = window.history.state;
  first.write(key, record("Saved text", false));
  expect(readLocalDraft(key)).toBeNull();
  expect(newPostDraftStore("writer", "topic-new:::").read(key)?.server?.id).toBe(1);
  expect(fresh().read(key)).toBeNull();
  window.history.replaceState(entry, "");
  expect(newPostDraftStore("writer", "topic-new:::").read(key)?.body).toBe("Saved text");
});

it("recovers an undelivered update with its link after closing the tab and clears only the delivered copy", () => {
  const first = fresh(); first.write(key, record("Offline change", true, 7));
  sessionStorage.clear();
  const recovered = fresh();
  expect(recovered.read(key)).toMatchObject({ body: "Offline change", server: { id: 7, version: 1 } });
  recovered.write(key, { ...record("Offline change", false, 7), server: { id: 7, version: 2 } });
  expect(readLocalDraft(key)).toBeNull();
  expect(fresh().read(key)).toBeNull();
});

it("a delayed keeper write cannot reintroduce an acknowledged device backup", () => {
  const store = fresh(); store.write(key, record("Saved text", false));
  const keeper = record("Saved text", false); delete keeper.pending;
  store.write(key, keeper);
  expect(readLocalDraft(key)).toBeNull();
  store.write(key, { ...keeper, body: "Next keystroke" });
  expect(readLocalDraft(key)).toMatchObject({ body: "Next keystroke", pending: true });
});

it("one editor acknowledging a save cannot erase another editor's undelivered writing", () => {
  const first = fresh(), second = fresh();
  first.write(key, record("First tab", true));
  second.write(key, record("Second tab", true, 2));
  first.write(key, record("First tab", false));
  expect(readLocalDraft(key)).toMatchObject({ body: "Second tab", server: { id: 2 } });
  expect(first.read(key)?.server?.id).toBe(1);
});

it("replacing a record does not inherit another draft's link or controls", () => {
  const store = fresh();
  for (const name of [key, olderLocalDraftKey(key)]) {
    store.write(name, { ...record("Linked text", true, 7), fields: JSON.stringify([["lang", "ja"]]) });
    store.write(name, { body: "Unlinked writing", base: baseOf("", ""), savedAt: 2 });
    expect(store.read(name)?.server).toBeUndefined();
    expect(store.read(name)?.fields).toBeUndefined();
    expect(readLocalDraft(name)?.body).toBe("Unlinked writing");
  }
});

it("restores legacy unsent writing, ignores delivered legacy links, and removes tab copies on logout", () => {
  const legacy = { body: "Older unsent text", base: baseOf("", ""), savedAt: 1 };
  writeLocalDraft(key, legacy);
  const store = fresh(); expect(store.read(key)?.body).toBe(legacy.body);
  store.remove(key); expect(readLocalDraft(key)).toBeNull();
  const saved = record("Saved text", false); delete saved.pending;
  writeLocalDraft(key, saved);
  expect(fresh().read(key)).toBeNull();
  clearLocalDrafts();
  expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(key => key?.startsWith("tomola:draft:"))).toEqual([]); expect(sessionStorage.length).toBe(0);
});

it("a fresh document retaining old history initializes the same empty editor twice", async () => {
  fresh().write(key, record("Saved text", false));
  const previous = window.history.state.draftEditorId;
  vi.resetModules();
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ name: "http://localhost/t/new", type: "navigate" }] as PerformanceNavigationTiming[]);
  const { newPostDraftStore: arrive } = await import("../app/lib/new-post-draft");
  const first = arrive("writer", "topic-new:::");
  const editor = window.history.state.draftEditorId;
  const second = arrive("writer", "topic-new:::");
  expect(editor).not.toBe(previous);
  expect(window.history.state.draftEditorId).toBe(editor);
  expect(first.read(key)).toBeNull();
  expect(second.read(key)).toBeNull();
});


it("rejects foreign-owner migration and deletion, and invalidates delayed editor operations on logout", () => {
  const own = localDraftKey("writer", "reply:1:"), foreign = localDraftKey("other", "reply:1:");
  const editor = draftStoreForOwner("writer", localDraftStore);
  const value = record("Unsent reply", true);
  writeLocalDraft(foreign, value);
  expect(editor.read(foreign)).toBeNull();
  expect(editor.write(foreign, value)).toBe(false);
  editor.remove(foreign);
  expect(readLocalDraft(foreign)).toEqual(value);
  expect(editor.write(own, value)).toBe(true);
  clearLocalDrafts();
  expect(editor.write(own, value)).toBe(false);
  const next = draftStoreForOwner("writer", localDraftStore);
  expect(next.write(own, value)).toBe(true);
  editor.remove(own);
  expect(editor.read(own)).toBeNull();
  expect(next.read(own)).toEqual(value);
});
