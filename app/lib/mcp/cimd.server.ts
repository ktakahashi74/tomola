import { fetchClientMetadataResource } from "@better-auth/cimd/node";

export type MetadataFetch = typeof fetchClientMetadataResource;
export const DCR_JWKS_DISCOVERY_ID = "tomola-dcr-jwks";

const MAX_BYTES = 64 * 1024;
const WINDOW_MS = 60_000;
const DEADLINE_MS = 3000;
const MAX_ACTIVE = 8;
const MAX_ORIGIN_ACTIVE = 4;
const MAX_STARTS = 120;
const MAX_ORIGIN_STARTS = 30;

type Resource = { request: Request; key: string; signal: AbortSignal };
type Snapshot = { body: Uint8Array<ArrayBuffer> | null; init: ResponseInit };

function resource(input: Parameters<MetadataFetch>[0], init?: RequestInit): Resource {
  const request = new Request(input, init);
  return { request, key: JSON.stringify([request.url, request.method, [...request.headers]]), signal: request.signal };
}

function respond(snapshot: Snapshot): Response {
  return new Response(snapshot.body, snapshot.init);
}

async function readSnapshot(response: Response, signal: AbortSignal): Promise<Snapshot> {
  if (response.redirected) throw new Error("Client metadata request redirected");
  const init = { status: response.status, statusText: response.statusText, headers: response.headers };
  if (response.status !== 200 || !response.body || Number(response.headers.get("content-length")) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 200 && response.body) throw new Error("Client metadata response is too large");
    return { body: null, init };
  }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) {
        abort();
        throw new Error("Client metadata response is too large");
      }
      chunks.push(part.value);
    }
    return { body: new Uint8Array(Buffer.concat(chunks, size)), init };
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, deadline]); }
  finally { signal.removeEventListener("abort", abort); }
}

export class MetadataFetchBusy extends Error {}

type ActiveFetch = { origin: string; result: Promise<Snapshot>; controller: AbortController; subscribers: number };

async function subscribe(active: ActiveFetch, signal: AbortSignal): Promise<Response> {
  active.subscribers += 1;
  try { return respond(await withSignal(active.result, signal)); }
  finally {
    active.subscribers -= 1;
    if (signal.aborted && active.subscribers === 0) active.controller.abort(signal.reason);
  }
}

function createTransport(fetch: MetadataFetch): MetadataFetch {
  const active = new Map<string, ActiveFetch>();
  let starts: { origin: string; time: number }[] = [];
  return async (input, init) => {
    const { request, key, signal } = resource(input, init);
    signal.throwIfAborted();
    const pending = active.get(key);
    if (pending) return subscribe(pending, signal);
    const origin = new URL(request.url).origin;
    const time = Date.now();
    starts = starts.filter(start => time - start.time < WINDOW_MS);
    if (active.size >= MAX_ACTIVE || [...active.values()].filter(fetch => fetch.origin === origin).length >= MAX_ORIGIN_ACTIVE
        || starts.length >= MAX_STARTS || starts.filter(start => start.origin === origin).length >= MAX_ORIGIN_STARTS) {
      throw new MetadataFetchBusy("Client metadata fetch budget exhausted");
    }
    starts.push({ origin, time });

    // Keep the permit until the underlying work settles. Node's DNS lookup can
    // outlive the deadline, even when no subscriber is still awaiting it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Client metadata request timed out", "TimeoutError")), DEADLINE_MS);
    const work = Promise.resolve().then(() => fetch(input, { ...init, signal: controller.signal })).then(response => readSnapshot(response, controller.signal));
    const current = { origin, result: withSignal(work, controller.signal), controller, subscribers: 0 };
    active.set(key, current);
    const release = () => { active.delete(key); clearTimeout(timer); };
    void work.then(release, release);
    return subscribe(current, signal);
  };
}

// Keep transport admission and in-flight responses shared even when Better
// Auth is rebound to a different database handle with fresh plugins.
export const fetchMcpClientMetadata = createTransport(fetchClientMetadataResource);
const transports = new WeakMap<MetadataFetch, MetadataFetch>();
export function sharedMetadataFetch(fetch?: MetadataFetch): MetadataFetch {
  if (!fetch) return fetchMcpClientMetadata;
  let transport = transports.get(fetch);
  if (!transport) {
    transport = createTransport(fetch);
    transports.set(fetch, transport);
  }
  return transport;
}

const NEED_RESOURCE = Symbol("OAuth client resource needed");

// The provider still chooses and validates every URL. Capture a cache miss in
// the transaction, then fetch only after its caller has rolled the transaction
// back. Retry the provider with the prepared bytes and the client lock held.
export async function withPreparedMetadata<T>(
  fetch: MetadataFetch,
  signal: AbortSignal,
  run: (preparedFetch: MetadataFetch, requirePrepared: () => void) => Promise<T>,
): Promise<T> {
  const prepared = new Map<string, { url: string; respond: () => Response }>();
  let pending: Resource | undefined;
  const preparedFetch: MetadataFetch = async (input, init) => {
    const needed = resource(input, init);
    const supply = prepared.get(needed.key);
    if (supply) return supply.respond();
    pending ??= needed;
    throw NEED_RESOURCE;
  };
  while (true) {
    signal.throwIfAborted();
    pending = undefined;
    try {
      return await run(preparedFetch, () => {
        if (pending) throw NEED_RESOURCE;
        signal.throwIfAborted();
      });
    } catch (error) {
      if (error !== NEED_RESOURCE || !pending) throw error;
      const { key, request } = pending as Resource;
      // After verifying a client assertion the provider reads the client again.
      // A no-cache metadata document can require one conditional revalidation.
      const conditional = request.headers.has("if-none-match") || request.headers.has("if-modified-since");
      const knownUrl = [...prepared.values()].some(resource => resource.url === request.url);
      if (prepared.size >= 3 || (prepared.size === 2 && !(conditional && knownUrl))) {
        throw new MetadataFetchBusy("Too many client resources for one request");
      }
      try {
        const response = await fetch(request.url, { method: request.method, headers: request.headers, redirect: "error", signal });
        const snapshot = await readSnapshot(response, signal);
        prepared.set(key, { url: request.url, respond: () => respond(snapshot) });
      } catch (failure) {
        if (failure instanceof MetadataFetchBusy || signal.aborted) throw failure;
        prepared.set(key, { url: request.url, respond: () => { throw failure; } });
      }
    }
  }
}
