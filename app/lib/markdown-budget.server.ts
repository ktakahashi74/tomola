import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import { Worker } from "node:worker_threads";

export const MARKDOWN_LIMITS = {
  workers: 2, perMember: 1, readQueue: 128, backgroundQueue: 16,
  readWaitMs: 250, writeWaitMs: 1500, backgroundWaitMs: 120_000,
  minCpuMs: 500, maxCpuMs: 4000, multiplier: 12,
  minTranslationCpuMs: 1000, maxTranslationCpuMs: 8000, translationMultiplier: 24,
  wallMs: 30_000, startupMs: 30_000, shutdownMs: 10_000,
  oldMb: 256, youngMb: 16, stackMb: 1,
  cacheEntries: 256, cacheBytes: 8 * 1024 * 1024,
} as const;

// CPU exhaustion is the executor's content error. Admission also returns a
// deterministic rendering rejection as a normal worker reply.
export class MarkdownBudgetError extends Error {
  readonly code = "body_too_complex";
  readonly reason = "cpu";
  constructor() { super("body_too_complex"); }
}
export class MarkdownBusyError extends Error {
  readonly status = 503;
  constructor(readonly reason: "busy" | "worker" | "wall" | "shutdown" = "busy") { super("Markdown processing is busy. Try again shortly."); }
}
type Mode = "read" | "write" | "background" | "restore";
type ReadSequence = { tail: Promise<void>; busy?: MarkdownBusyError };
type Scope = { mode: Mode; member?: string; readSequence?: ReadSequence };
const scopeGlobal = globalThis as typeof globalThis & { __tomolaMarkdownScope?: AsyncLocalStorage<Scope> };
const scope = scopeGlobal.__tomolaMarkdownScope ??= new AsyncLocalStorage<Scope>();
const currentScope = (): Scope => scope.getStore() ?? { mode: "read" };
export const isMarkdownWrite = () => currentScope().mode === "write";
export function withMarkdownRead<T>(work: () => T): T {
  const current = currentScope();
  return scope.run({ ...current, mode: current.mode === "background" || current.mode === "restore" ? current.mode : "read", readSequence: current.readSequence ?? { tail: Promise.resolve() } }, work);
}
export function withMarkdownRestore<T>(work: () => T): T {
  const current = currentScope();
  return scope.run({ ...current, mode: current.mode === "background" ? "background" : "restore" }, work);
}
export function withMarkdownPersistedRead<T>(work: () => T): T {
  return currentScope().mode === "write" ? work() : withMarkdownRestore(work);
}
export function withMarkdownScope<T>(mode: Mode, member: string | undefined, work: () => T): T { return scope.run({ mode, member, ...(mode === "read" ? { readSequence: { tail: Promise.resolve() } } : {}) }, work); }
export function setMarkdownMember(member: string): void { const current = scope.getStore(); if (current) current.member = member; }
export function canFallbackMarkdown(error: unknown): boolean {
  if (error instanceof MarkdownBusyError && currentScope().mode === "read" && currentScope().readSequence) currentScope().readSequence!.busy ??= error;
  return error instanceof MarkdownBudgetError ? !isMarkdownWrite() : error instanceof MarkdownBusyError && currentScope().mode === "read";
}
export const markdownReadBusy = () => currentScope().mode === "read" && currentScope().readSequence?.busy !== undefined;

type Reply = { phase?: "ready" | "started"; baseline?: NodeJS.CpuUsage; value?: unknown; cpuMs?: number; error?: string };
type Slot = { worker?: Worker; busy: boolean; cancel?: () => Promise<void> };
type Cached = { value?: unknown; error?: MarkdownBudgetError; bytes: number };
type Waiter = { current: Scope; resolve: (slot: Slot) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type MarkdownExecutorOptions = {
  cpuMs?: number; translationCpuMs?: number; wallMs?: number; startupMs?: number; shutdownMs?: number;
  readWaitMs?: number; writeWaitMs?: number; backgroundWaitMs?: number; workerFile?: string;
};
const translationOperations = new Set(["inspectTranslation", "checkStructure", "judgeCopy", "looksUntranslated", "detectCopy", "bigramDice"]);
const defaultWorkerFile = fileURLToPath(new URL("../../server/markdown-worker.mjs", import.meta.url));

// Idle workers close their message port and leave V8 through its normal exit
// path. Keep a bounded fallback for a worker that cannot handle the notification.
async function closeMarkdownWorker(worker: Worker): Promise<void> {
  if (worker.threadId === -1) return;
  worker.ref();
  await new Promise<void>((resolve, reject) => {
    let forced = false;
    const finish = (error?: unknown) => {
      clearTimeout(timer); worker.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    const onExit = () => finish();
    const force = () => {
      if (forced) return; forced = true;
      void worker.terminate().then(() => finish(), finish);
    };
    const timer = setTimeout(force, 2000);
    worker.once("exit", onExit);
    try { worker.postMessage({ type: "shutdown" }); } catch { force(); }
  });
}

export function createMarkdownExecutor(options: MarkdownExecutorOptions = {}) {
  const slots: Slot[] = Array.from({ length: MARKDOWN_LIMITS.workers }, () => ({ busy: false }));
  const members = new Map<string, number>();
  const waiting: Waiter[] = [];
  const idle = new Set<() => void>();
  const cache = new Map<string, Cached>();
  let cacheBytes = 0, stopping = false, closed = false, initializing = false, calibrated: Promise<number> | undefined;
  let cpuMs = options.cpuMs ?? MARKDOWN_LIMITS.minCpuMs;
  let translationCpuMs = options.translationCpuMs ?? (options.cpuMs === undefined ? MARKDOWN_LIMITS.minTranslationCpuMs : options.cpuMs * 2);

  function notifyIdle() { if (!initializing && slots.every(slot => !slot.busy)) for (const done of idle) done(); }
  async function start(slot: Slot): Promise<Worker> {
    if (closed) throw new MarkdownBusyError("shutdown");
    if (slot.worker) return slot.worker;
    let worker: Worker;
    try {
      worker = new Worker(options.workerFile ?? defaultWorkerFile, {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: MARKDOWN_LIMITS.oldMb, maxYoungGenerationSizeMb: MARKDOWN_LIMITS.youngMb, stackSizeMb: MARKDOWN_LIMITS.stackMb },
      });
    } catch { throw new MarkdownBusyError("worker"); }
    slot.worker = worker;
    worker.on("error", () => { if (!slot.busy && slot.worker === worker) slot.worker = undefined; });
    worker.on("exit", () => { if (!slot.busy && slot.worker === worker) slot.worker = undefined; });
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return; finished = true;
        clearTimeout(timer); worker.off("message", onMessage); worker.off("error", onError); worker.off("exit", onError);
        error ? reject(error) : resolve();
      };
      const onMessage = (reply: Reply) => { if (reply.phase === "ready") finish(); };
      const onError = () => finish(new MarkdownBusyError("worker"));
      const timer = setTimeout(() => finish(new MarkdownBusyError("wall")), options.startupMs ?? MARKDOWN_LIMITS.startupMs);
      worker.on("message", onMessage); worker.once("error", onError); worker.once("exit", onError);
    }).catch(async error => { await worker.terminate(); slot.worker = undefined; throw error; });
    worker.unref(); return worker;
  }

  async function perform(slot: Slot, operation: string, args: unknown[], limit: number): Promise<unknown> {
    const worker = await start(slot); worker.ref();
    return new Promise((resolve, reject) => {
      let finished = false, wall: NodeJS.Timeout | undefined, poll: NodeJS.Timeout | undefined, checking = false;
      const finish = async (value: unknown, error?: Error) => {
        if (finished) return; finished = true;
        clearTimeout(wall); clearInterval(poll); slot.cancel = undefined;
        worker.off("message", onMessage); worker.off("error", onError); worker.off("exit", onError);
        if (error) { await worker.terminate(); slot.worker = undefined; } else worker.unref();
        error ? reject(error) : resolve(value);
      };
      slot.cancel = () => finish(undefined, new MarkdownBusyError("shutdown"));
      const watchdog = () => void finish(undefined, new MarkdownBusyError("wall"));
      const onMessage = (reply: Reply) => {
        if (reply.phase === "started") {
          clearTimeout(wall); wall = setTimeout(watchdog, options.wallMs ?? MARKDOWN_LIMITS.wallMs);
          if (typeof worker.cpuUsage === "function") poll = setInterval(async () => {
            if (finished || checking) return; checking = true;
            try {
              const usage = await worker.cpuUsage(reply.baseline);
              if (!finished && (usage.user + usage.system) / 1000 > limit) void finish(undefined, new MarkdownBudgetError());
            } catch { if (!finished) void finish(undefined, new MarkdownBusyError("worker")); }
            finally { checking = false; }
          }, 25);
          return;
        }
        if (typeof reply.cpuMs === "number" && reply.cpuMs > limit) void finish(undefined, new MarkdownBudgetError());
        else if (reply.error || !Number.isFinite(reply.cpuMs)) void finish(undefined, new MarkdownBusyError("worker"));
        else void finish(reply.value);
      };
      const onError = () => void finish(undefined, new MarkdownBusyError("worker"));
      worker.on("message", onMessage); worker.once("error", onError); worker.once("exit", onError);
      wall = setTimeout(watchdog, options.wallMs ?? MARKDOWN_LIMITS.wallMs);
      try { worker.postMessage({ operation, args, env: { BETTER_AUTH_URL: process.env.BETTER_AUTH_URL, NODE_ENV: process.env.NODE_ENV } }); }
      catch { void finish(undefined, new MarkdownBusyError("worker")); }
    });
  }

  function initialize(): Promise<number> {
    return calibrated ??= (async () => {
      if (options.cpuMs !== undefined) return cpuMs;
      initializing = true;
      try {
        const values = await perform(slots[0], "calibrate", [], MARKDOWN_LIMITS.maxTranslationCpuMs * 10) as number[];
        if (values.length !== 10 || values.some(value => !Number.isFinite(value) || value < 0)) throw new MarkdownBusyError("worker");
        const sorted = values.sort((a, b) => a - b); const median = (sorted[4] + sorted[5]) / 2;
        cpuMs = Math.min(MARKDOWN_LIMITS.maxCpuMs, Math.max(MARKDOWN_LIMITS.minCpuMs, median * MARKDOWN_LIMITS.multiplier));
        translationCpuMs = options.translationCpuMs ?? Math.min(MARKDOWN_LIMITS.maxTranslationCpuMs, Math.max(MARKDOWN_LIMITS.minTranslationCpuMs, median * MARKDOWN_LIMITS.translationMultiplier));
        console.info("[markdown] CPU budget " + cpuMs.toFixed(1) + " ms (median " + median.toFixed(1) + " ms × 12, bounds 500–4000 ms); translation inspection " + translationCpuMs.toFixed(1) + " ms (× 24, bounds 1000–8000 ms)");
        return cpuMs;
      } finally { initializing = false; notifyIdle(); }
    })();
  }

  function remember(key: string, saved: Cached): void {
    const previous = cache.get(key);
    if (previous) { cacheBytes -= previous.bytes; cache.delete(key); }
    if (saved.bytes > MARKDOWN_LIMITS.cacheBytes) return;
    while (cache.size && (cache.size >= MARKDOWN_LIMITS.cacheEntries || cacheBytes + saved.bytes > MARKDOWN_LIMITS.cacheBytes)) {
      const first = cache.keys().next().value!; cacheBytes -= cache.get(first)!.bytes; cache.delete(first);
    }
    cache.set(key, saved); cacheBytes += saved.bytes;
  }
  const available = (current: Scope) => current.member && (members.get(current.member) ?? 0) >= MARKDOWN_LIMITS.perMember ? undefined : slots.find(slot => !slot.busy);
  function reserve(slot: Slot, current: Scope): Slot {
    slot.busy = true; if (current.member) members.set(current.member, (members.get(current.member) ?? 0) + 1); return slot;
  }
  function wakeEligible(): void {
    if (stopping) return;
    for (let i = 0; i < waiting.length;) {
      const next = waiting[i], slot = available(next.current);
      if (!slot) { i++; continue; }
      waiting.splice(i, 1); clearTimeout(next.timer); next.resolve(reserve(slot, next.current));
    }
  }
  async function acquire(current: Scope): Promise<Slot> {
    if (stopping) throw new MarkdownBusyError("shutdown");
    const free = available(current); if (free) return reserve(free, current);
    const background = current.mode === "background";
    const capacity = background ? MARKDOWN_LIMITS.backgroundQueue : MARKDOWN_LIMITS.readQueue;
    const waitMs = background ? options.backgroundWaitMs ?? MARKDOWN_LIMITS.backgroundWaitMs : current.mode === "read" ? options.readWaitMs ?? MARKDOWN_LIMITS.readWaitMs : options.writeWaitMs ?? MARKDOWN_LIMITS.writeWaitMs;
    const deadline = performance.now() + waitMs;
    const full = () => waiting.filter(w => (w.current.mode === "background") === background).length >= capacity;
    if (!background && full()) throw new MarkdownBusyError();
    // Trusted job producers also wait for queue admission. A full read queue
    // cannot turn post-engine processing into an immediate charged retry.
    while (background && full()) {
      if (stopping) throw new MarkdownBusyError("shutdown");
      const remaining = deadline - performance.now(); if (remaining <= 0) throw new MarkdownBusyError();
      await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 50)));
    }
    if (stopping) throw new MarkdownBusyError("shutdown");
    const ready = available(current); if (ready) return reserve(ready, current);
    const remaining = deadline - performance.now(); if (remaining <= 0) throw new MarkdownBusyError();
    return new Promise<Slot>((resolve, reject) => {
      const next: Waiter = { current, resolve, reject, timer: setTimeout(() => {
        const index = waiting.indexOf(next); if (index >= 0) waiting.splice(index, 1);
        reject(new MarkdownBusyError()); wakeEligible();
      }, remaining) };
      waiting.push(next);
    });
  }
  let stopped: Promise<void> | undefined;
  return {
    initialize,
    get cpuMs() { return cpuMs; }, get translationCpuMs() { return translationCpuMs; },
    async run<T>(operation: string, args: unknown[]): Promise<T> {
      if (stopping) throw new MarkdownBusyError("shutdown");
      const current = { ...currentScope() };
      const key = createHash("sha256").update(serialize([operation, args, process.env.BETTER_AUTH_URL, process.env.NODE_ENV])).digest("hex");
      const saved = cache.get(key); if (saved) { if (saved.error) throw saved.error; return structuredClone(saved.value) as T; }
      // Rows and replies in one response must not consume each other's short
      // pool-admission deadline. Separate requests retain the member limit.
      let release = () => {};
      if (current.mode === "read" && current.readSequence) {
        const previous = current.readSequence.tail;
        current.readSequence.tail = new Promise<void>(resolve => { release = resolve; });
        await previous;
      }
      try {
        const reused = cache.get(key); if (reused) { if (reused.error) throw reused.error; return structuredClone(reused.value) as T; }
        if (current.mode === "read" && current.readSequence?.busy) throw current.readSequence.busy;
        await initialize();
        const slot = await acquire(current);
        try {
          const value = await perform(slot, operation, args, translationOperations.has(operation) ? translationCpuMs : cpuMs) as T;
          remember(key, { value, bytes: serialize(value).length }); return value;
        } catch (error) {
          if (error instanceof MarkdownBudgetError) remember(key, { error, bytes: 128 }); throw error;
        } finally {
          slot.busy = false;
          if (current.member) { const left = (members.get(current.member) ?? 1) - 1; if (left) members.set(current.member, left); else members.delete(current.member); }
          wakeEligible(); notifyIdle();
        }
      } catch (error) {
        // One failed wait exhausts this response, not other requests or writes.
        if (error instanceof MarkdownBusyError && current.mode === "read" && current.readSequence) current.readSequence.busy ??= error;
        throw error;
      } finally { release(); }
    },
    stop(): Promise<void> {
      return stopped ??= (async () => {
        stopping = true;
        for (const next of waiting.splice(0)) { clearTimeout(next.timer); next.reject(new MarkdownBusyError("shutdown")); }
        if (initializing || slots.some(slot => slot.busy)) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); idle.delete(done); resolve(); };
          const timer = setTimeout(done, options.shutdownMs ?? MARKDOWN_LIMITS.shutdownMs); idle.add(done);
        });
        closed = true;
        await Promise.all(slots.map(async slot => {
          await slot.cancel?.();
          if (slot.worker) await closeMarkdownWorker(slot.worker);
          slot.worker = undefined;
        }));
        cache.clear(); cacheBytes = 0;
      })();
    },
  };
}
type Executor = ReturnType<typeof createMarkdownExecutor>;
const global = globalThis as typeof globalThis & { __tomolaMarkdown?: Executor };
const executor = () => global.__tomolaMarkdown ??= createMarkdownExecutor();
export function initializeMarkdown(options?: MarkdownExecutorOptions) { return (global.__tomolaMarkdown ??= createMarkdownExecutor(options)).initialize(); }
export const stopMarkdown = () => executor().stop();
export const markdownTask = <T>(operation: string, args: unknown[]): Promise<T> => executor().run<T>(operation, args);
export async function setMarkdownExecutorForTests(replacement: Executor): Promise<void> { await global.__tomolaMarkdown?.stop(); global.__tomolaMarkdown = replacement; }
export function isMarkdownStop(error: unknown): boolean { return error instanceof MarkdownBudgetError || error instanceof MarkdownBusyError; }
