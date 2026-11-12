import { afterEach, expect, it, vi } from "vitest";
import { PwaRegistration } from "~/components/pwa-registration";
import { draftStoreForOwner, localDraftKey, localDraftStore } from "~/lib/local-draft";

const { effects, clearBrowserPush, startPushLifecycle, dispose } = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  clearBrowserPush: vi.fn(async () => {}),
  startPushLifecycle: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("react", () => ({ useEffect: (effect: () => void | (() => void)) => effects.push(effect) }));
vi.mock("~/lib/push/lifecycle.client", () => ({ clearBrowserPush, startPushLifecycle }));

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
  };
}

afterEach(() => { effects.length = 0; vi.clearAllMocks(); vi.unstubAllGlobals(); });

it.each(["previous-member", "another-member"])("preserves %s writing and restarts push with an unchanged logout notice", async memberId => {
  const local = storage(), session = storage();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("window", { localStorage: local, sessionStorage: session, dispatchEvent: vi.fn() });
  vi.stubGlobal("navigator", { serviceWorker: {} });
  startPushLifecycle.mockReturnValue(dispose);

  const render = async (memberId: string | null, loggedOut: boolean) => {
    effects.length = 0;
    PwaRegistration({ memberId, loggedOut, pushEnabled: true });
    const cleanup = effects[1]();
    await vi.dynamicImportSettled();
    return cleanup;
  };
  const beforeLogout = await render("previous-member", false);
  expect(startPushLifecycle).toHaveBeenCalledTimes(1);
  const oldStore = draftStoreForOwner("previous-member", localDraftStore);
  const oldKey = localDraftKey("previous-member", "topic-new");
  oldStore.write(oldKey, { body: "Old writing", base: "", savedAt: 1 });
  if (typeof beforeLogout === "function") beforeLogout();
  expect(dispose).toHaveBeenCalledTimes(1);
  const afterLogout = await render(null, true);
  expect(local.getItem(oldKey)).toBeNull();
  expect(oldStore.active()).toBe(false);
  expect(clearBrowserPush).toHaveBeenCalledTimes(1);
  if (typeof afterLogout === "function") afterLogout();

  // The new editor renders before the root effect, while root loader data stays unchanged.
  const currentStore = draftStoreForOwner(memberId, localDraftStore);
  const currentKey = localDraftKey(memberId, "topic-new");
  const writing = { body: "New writing", base: "", savedAt: 2 };
  currentStore.write(currentKey, writing);
  const afterLogin = await render(memberId, true);
  expect(currentStore.active()).toBe(true);
  expect(currentStore.read(currentKey)).toEqual(writing);
  expect(clearBrowserPush).toHaveBeenCalledTimes(1);
  expect(startPushLifecycle).toHaveBeenCalledTimes(2);
  if (typeof afterLogin === "function") afterLogin();
  expect(dispose).toHaveBeenCalledTimes(2);
});
