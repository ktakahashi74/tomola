import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("waits for visibility, deduplicates navigation displays, and drops raw referrers before sending", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  let visible = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal("window", { history: { state: { key: "first" } } });
  vi.stubGlobal("location", new URL("https://forum.example/t/1?lang=en&sl=en"));
  vi.stubGlobal("document", { get visibilityState() { return visible ? "visible" : "hidden"; }, referrer: "https://www.google.com/search?q=private+words",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) });
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ counted: false }) }); vi.stubGlobal("fetch", fetch);
  const { markTopicRead } = await import("~/lib/translation-seen");
  const display = { page: "/t/1?lang=en&sl=en" };
  const cleanup = markTopicRead(display.page, "en", false);
  expect(fetch).not.toHaveBeenCalled();
  listeners.forEach(fn => fn());
  expect(fetch).not.toHaveBeenCalled();
  visible = true; listeners.forEach(fn => fn());
  expect(listeners.size).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ intent: "read", ids: [], internal: false, shared: true, referrerHost: "www.google.com", shown: "original" });
  expect(fetch.mock.calls[0][1].body).not.toContain("private");
  const again = markTopicRead(display.page, "en", false);
  expect(fetch).toHaveBeenCalledTimes(1);
  cleanup(); again();
  await vi.advanceTimersByTimeAsync(0);
  vi.stubGlobal("location", new URL("https://forum.example/t/2"));
  markTopicRead("/t/2", "en", false)();
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
  markTopicRead("/t/3", "en", false)();
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
  markTopicRead("/t/4", "en", false)();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ internal: true, referrerHost: "" });
});

it.each([
  ["/t/5?lang=ja&sl=ja", "/t/5?lang=ja", true],
  ["/t/5?lang=en", "/t/5?lang=en&sl=en", false],
  ["/t/5?lang=ja&posted=5&edited=5&followed=1", "/t/5?lang=ja", false],
] as const)("preserves arrival classification after transient query changes from %s to %s", async (page, address, shared) => {
  vi.resetModules();
  vi.stubGlobal("window", { history: { state: { key: "arrival" } } });
  vi.stubGlobal("location", new URL(address, "https://forum.example"));
  vi.stubGlobal("document", { visibilityState: "visible", referrer: "", addEventListener() {}, removeEventListener() {} });
  const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetch);
  const { markTopicRead } = await import("~/lib/translation-seen");
  const display = { page };
  markTopicRead(display.page, "en", false)();
  expect(fetch).toHaveBeenCalledTimes(1);
  markTopicRead(`${address}#reply`, "en", false)();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(`/t/5/translations${new URL(address, "https://forum.example").search}`);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ internal: false, shared });

});

function stubTab(fetch: ReturnType<typeof vi.fn>) {
  const saved = new Map<string, string>();
  vi.stubGlobal("window", { history: { state: null } });
  vi.stubGlobal("document", { visibilityState: "visible", referrer: "", addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("location", new URL("https://forum.example/t/6?lang=ja"));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  return saved;
}

const counted = () => ({ ok: true, json: async () => ({ counted: true }) });

it.each([
  { result: "counted false", startsVisible: true, counted: false, elapsed: 0 },
  { result: "counted true and the deduplication window expires", startsVisible: false, counted: true, elapsed: 1_800_000 },
])("does not resend on tab return after $result", async ({ startsVisible, counted, elapsed }) => {
  vi.resetModules();
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ counted }) });
  stubTab(fetch);
  const tab = Object.assign(new EventTarget(), { visibilityState: startsVisible ? "visible" : "hidden", referrer: "" });
  vi.stubGlobal("document", tab);
  const setVisibility = (state: string) => {
    tab.visibilityState = state;
    tab.dispatchEvent(new Event("visibilitychange"));
  };
  const { markTopicRead } = await import("~/lib/translation-seen");
  const cleanup = markTopicRead("/t/6?lang=ja", "ja", false);
  if (!startsVisible) setVisibility("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);

  setVisibility("hidden");
  await vi.advanceTimersByTimeAsync(elapsed);
  setVisibility("visible");
  expect(fetch).toHaveBeenCalledTimes(1);
  cleanup();
});

it("keeps the actual language and version distinct across reloads with a fixed 30-minute expiry", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(async () => counted());
  const saved = stubTab(fetch);
  const page = "/t/6?lang=ja";
  let { markTopicRead } = await import("~/lib/translation-seen");
  markTopicRead(page, "ja", false, "fixture-mark")();
  await vi.advanceTimersByTimeAsync(0);
  markTopicRead(page, "en", true)();
  await vi.advanceTimersByTimeAsync(0);
  markTopicRead(page, "fr", true)();
  await vi.advanceTimersByTimeAsync(0);
  markTopicRead(page, "ja", false)();
  await vi.advanceTimersByTimeAsync(1_799_999);
  vi.resetModules();
  ({ markTopicRead } = await import("~/lib/translation-seen"));
  markTopicRead(page, "ja", false)();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect([...saved.keys()]).toEqual(["tomola:read-dedupe:v1"]);
  expect(Object.keys(JSON.parse([...saved.values()][0]))).toEqual(["/t/6:ja:orig", "/t/6:en:tr", "/t/6:fr:tr"]);
  expect([...saved.values()][0]).not.toContain("fixture-mark");
  await vi.advanceTimersByTimeAsync(1);
  markTopicRead(page, "ja", false)();
  expect(fetch).toHaveBeenCalledTimes(4);
});

it.each(["access", "quota"])("uses the same fixed window in memory when storage fails on %s", async mode => {
  vi.resetModules();
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(async () => counted());
  stubTab(fetch);
  const fail = () => { throw new Error("Storage unavailable"); };
  vi.stubGlobal("sessionStorage", { getItem: mode === "access" ? fail : () => null, setItem: fail });
  const { markTopicRead } = await import("~/lib/translation-seen");
  const report = () => markTopicRead("/t/6?lang=ja", "ja", false)();
  report();
  await vi.advanceTimersByTimeAsync(0);
  report();
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_800_000);
  report();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("evicts the oldest record after 100 successes", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(async () => counted());
  const saved = stubTab(fetch);
  const { markTopicRead } = await import("~/lib/translation-seen");
  const report = (id: number) => {
    vi.stubGlobal("location", new URL(`https://forum.example/t/${id}`));
    markTopicRead(`/t/${id}`, "ja", false)();
  };
  for (let id = 1; id <= 101; id++) {
    report(id);
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(Object.keys(JSON.parse([...saved.values()][0]))).toHaveLength(100);
  report(2);
  expect(fetch).toHaveBeenCalledTimes(101);
  report(1);
  expect(fetch).toHaveBeenCalledTimes(102);
});

it("allows another attempt after transport failure, HTTP error, or counted false", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ counted: false }) }).mockImplementation(async () => counted());
  const saved = stubTab(fetch);
  const { markTopicRead } = await import("~/lib/translation-seen");
  for (let i = 0; i < 3; i++) {
    markTopicRead("/t/6?lang=ja", "ja", false)();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.size).toBe(0);
  }
  markTopicRead("/t/6?lang=ja", "ja", false)();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(saved.size).toBe(1);
  expect(fetch.mock.calls.map(([, request]) => JSON.parse(request.body).internal)).toEqual([false, false, false, true]);
});
