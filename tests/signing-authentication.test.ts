import { expect, it, vi } from "vitest";
import { createSigningAuthenticationLoader } from "~/lib/signing-authentication";

it("preloads one authentication module without asking for a passkey and reuses the loaded function", async () => {
  const authenticate = vi.fn();
  let resolve!: (module: { startAuthentication: typeof authenticate }) => void;
  const importModule = vi.fn(() => new Promise<{ startAuthentication: typeof authenticate }>(done => { resolve = done; }));
  const load = createSigningAuthenticationLoader(importModule);
  const first = load();
  expect(load()).toBe(first);
  expect(importModule).toHaveBeenCalledTimes(1);
  expect(authenticate).not.toHaveBeenCalled();
  resolve({ startAuthentication: authenticate });
  expect(await first).toBe(authenticate);
  expect(await load()).toBe(authenticate);
  expect(importModule).toHaveBeenCalledTimes(1);
  expect(authenticate).not.toHaveBeenCalled();
});

it("allows another preload after a failed import", async () => {
  const failure = new TypeError("Module could not load");
  const authenticate = vi.fn();
  const importModule = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ startAuthentication: authenticate });
  const load = createSigningAuthenticationLoader(importModule);
  await expect(load()).rejects.toBe(failure);
  expect(await load()).toBe(authenticate);
  expect(importModule).toHaveBeenCalledTimes(2);
  expect(authenticate).not.toHaveBeenCalled();
});
