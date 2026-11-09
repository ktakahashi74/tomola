import { afterEach, expect, it, vi } from "vitest";
import { markTranslationSeen } from "~/lib/translation-seen";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("deduplicates a rendered snapshot but reports reused rows again after a loader refresh", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("location", { pathname: "/t/1", search: "?lang=fr" });
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const ids = [91001];
  markTranslationSeen(ids);
  await vi.runAllTimersAsync();
  markTranslationSeen(ids);
  await vi.runAllTimersAsync();
  expect(fetch).toHaveBeenCalledTimes(1);
  markTranslationSeen([...ids]);
  await vi.runAllTimersAsync();
  expect(fetch).toHaveBeenCalledTimes(2);
});
