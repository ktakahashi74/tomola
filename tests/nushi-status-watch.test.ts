import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import NushiStatusWatches from "~/components/nushi-status-watch";

const { effects, revalidate } = vi.hoisted(() => ({
  effects: [] as Array<() => () => void>,
  revalidate: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => () => void) => effects.push(effect),
  useEffectEvent: (callback: () => void) => callback,
}));
vi.mock("react-router", () => ({ useRevalidator: () => ({ revalidate }) }));

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.(); cleanup = undefined;
  effects.length = 0;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

function watch(hidden = false) {
  vi.useFakeTimers();
  const document = Object.assign(new EventTarget(), { hidden });
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "pending" }) });
  vi.stubGlobal("document", document);
  vi.stubGlobal("fetch", fetch);
  renderToStaticMarkup(createElement(NushiStatusWatches, { requestIds: ["request"] }));
  cleanup = effects[0]();
  return {
    fetch,
    visibility(hidden: boolean) { document.hidden = hidden; document.dispatchEvent(new Event("visibilitychange")); },
  };
}

it.each([false, true])("preserves the visible-time budget across a long hidden period (initially hidden: %s)", async hidden => {
  const w = watch(hidden);
  if (!hidden) { await vi.advanceTimersByTimeAsync(2000); expect(w.fetch).toHaveBeenCalledTimes(1); w.visibility(true); }
  const before = w.fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(w.fetch).toHaveBeenCalledTimes(before);
  w.fetch.mockResolvedValue({ ok: true, json: async () => ({ state: "answered" }) });
  w.visibility(false);
  expect(w.fetch).toHaveBeenCalledTimes(before + 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(revalidate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(w.fetch).toHaveBeenCalledTimes(before + 1);
});

it("checks immediately on return after backing off and keeps a single retry schedule", async () => {
  const w = watch();
  await vi.advanceTimersByTimeAsync(17_000);
  expect(w.fetch).toHaveBeenCalledTimes(4);
  w.visibility(true);
  await vi.advanceTimersByTimeAsync(60_000);
  w.visibility(false);
  expect(w.fetch).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(9999);
  expect(w.fetch).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1);
  expect(w.fetch).toHaveBeenCalledTimes(6);
});

it("aborts hidden reads and ignores their late completion after resuming", async () => {
  const w = watch();
  let finish!: (value: unknown) => void;
  w.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(2000);
  const signal = w.fetch.mock.calls[0][1].signal as AbortSignal;
  w.visibility(true);
  expect(signal.aborted).toBe(true);
  w.visibility(false);
  await vi.advanceTimersByTimeAsync(0);
  finish({ ok: true, json: async () => ({ state: "answered" }) });
  await vi.advanceTimersByTimeAsync(0);
  expect(revalidate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4500);
  expect(w.fetch).toHaveBeenCalledTimes(3);
});

it("stops after five minutes of visible time even after returning to the tab", async () => {
  const w = watch();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  const before = w.fetch.mock.calls.length;
  expect(before).toBeGreaterThan(0);
  expect(before).toBeLessThan(40);
  w.visibility(true);
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  w.visibility(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(w.fetch).toHaveBeenCalledTimes(before);
});

it("retains the attempt limit across repeated tab returns", async () => {
  const w = watch();
  for (let i = 0; i < 45; i++) {
    w.visibility(true); w.visibility(false);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(w.fetch).toHaveBeenCalledTimes(40);
});

it.each([401, 403, 404])("refreshes only once after a %s response", async status => {
  const w = watch();
  w.fetch.mockResolvedValue({ ok: false, status });
  await vi.advanceTimersByTimeAsync(2000);
  w.visibility(true); w.visibility(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(w.fetch).toHaveBeenCalledTimes(1);
  expect(revalidate).toHaveBeenCalledTimes(1);
});
