import { AsyncLocalStorage } from "node:async_hooks";

// Carry cancellation through shared LLM helpers without changing individual job payloads.
const signals = new AsyncLocalStorage<AbortSignal | undefined>();
export const currentJobSignal = (): AbortSignal | undefined => signals.getStore();
export function withJobSignal<T>(signal: AbortSignal | undefined, run: () => T): T { return signals.run(signal, run); }

// Cooperating SDKs stop their request. The race also lets queue bookkeeping finish
// promptly if a handler is awaiting work that does not support cancellation.
export async function abortable<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return run();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([run(), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
