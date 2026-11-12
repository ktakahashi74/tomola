import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); });
it("waits for visibility, deduplicates navigation displays, and drops raw referrers before sending", async () => {
  vi.resetModules();
  let visible = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal("window", { history: { state: { key: "first" } } });
  vi.stubGlobal("location", new URL("https://forum.example/t/1?lang=en&sl=en"));
  vi.stubGlobal("document", { get visibilityState() { return visible ? "visible" : "hidden"; }, referrer: "https://www.google.com/search?q=private+words",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) });
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetch);
  const { markTopicRead } = await import("~/lib/translation-seen");
  const display = { page: "/t/1?lang=en&sl=en" };
  const cleanup = markTopicRead(display.page);
  expect(fetch).not.toHaveBeenCalled();
  visible = true; listeners.forEach(fn => fn());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ intent: "read", ids: [], internal: false, shared: true, referrerHost: "www.google.com" });
  expect(fetch.mock.calls[0][1].body).not.toContain("private");
  const again = markTopicRead(display.page);
  expect(fetch).toHaveBeenCalledTimes(1);
  cleanup(); again();
  vi.stubGlobal("location", new URL("https://forum.example/t/2"));
  markTopicRead("/t/2")();
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ internal: true, referrerHost: "" });
});
it("removes hidden-page callbacks when navigation leaves before the page becomes visible", async () => {
  vi.resetModules();
  let visible = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal("window", { history: { state: null } });
  vi.stubGlobal("location", new URL("https://forum.example/t/3"));
  vi.stubGlobal("document", { get visibilityState() { return visible ? "visible" : "hidden"; }, referrer: "",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { markTopicRead } = await import("~/lib/translation-seen");
  markTopicRead("/t/3")();
  visible = true; listeners.forEach(fn => fn());
  expect(fetch).not.toHaveBeenCalled();
});

it("treats the first article after a client navigation from a list as internal", async () => {
  vi.resetModules();
  const history = { state: { key: "list-document" } };
  vi.stubGlobal("window", { history });
  vi.stubGlobal("document", { visibilityState: "visible", referrer: "https://www.google.com/search?q=private", addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("location", new URL("https://forum.example/t/4"));
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetch);
  const { markTopicRead } = await import("~/lib/translation-seen");
  history.state = { key: "article-navigation" };
  markTopicRead("/t/4")();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ internal: true, referrerHost: "" });
});

it.each([
  ["/t/5?lang=ja&sl=ja", "/t/5?lang=ja", true],
  ["/t/5?lang=en", "/t/5?lang=en&sl=en", false],
] as const)("preserves arrival classification when the share address changes from %s to %s", async (page, address, shared) => {
  vi.resetModules();
  vi.stubGlobal("window", { history: { state: { key: "arrival" } } });
  vi.stubGlobal("location", new URL(address, "https://forum.example"));
  vi.stubGlobal("document", { visibilityState: "visible", referrer: "", addEventListener() {}, removeEventListener() {} });
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetch);
  const { markTopicRead } = await import("~/lib/translation-seen");
  const display = { page };
  markTopicRead(display.page)();
  markTopicRead(`${address}#reply`)();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(`/t/5/translations${new URL(address, "https://forum.example").search}`);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ internal: false, shared });

});

it("counts each pathname once across query changes, pagination and navigation away and back", async () => {
  vi.resetModules();
  vi.stubGlobal("window", { history: { state: null } });
  vi.stubGlobal("document", { visibilityState: "visible", referrer: "", addEventListener() {}, removeEventListener() {} });
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("location", new URL("https://forum.example/t/6?lang=ja"));
  const { markTopicRead } = await import("~/lib/translation-seen");
  for (const page of ["/t/6?lang=ja", "/t/6?lang=en", "/t/6?tag=agree", "/t/6?page=2", "/t/6?page=1", "/t/6?posted=7", "/t/6?orig=6&tr=7&old=1", "/t/7", "/t/6?lang=fr#reply"]) {
    vi.stubGlobal("location", new URL(page, "https://forum.example"));
    markTopicRead(page)();
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][0]).toBe("/t/6/translations?lang=ja");
  expect(fetch.mock.calls[1][0]).toBe("/t/7/translations");
  // A new document starts a new in-memory set.
  vi.resetModules();
  (await import("~/lib/translation-seen")).markTopicRead("/t/6?lang=fr")();
  expect(fetch).toHaveBeenCalledTimes(3);
});
