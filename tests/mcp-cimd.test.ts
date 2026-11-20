import { EventEmitter } from "node:events";
import dns from "node:dns/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { fetchMcpClientMetadata, MetadataFetchBusy, sharedMetadataFetch, withPreparedMetadata, type MetadataFetch } from "~/lib/mcp/cimd.server";
import { deferred } from "./helpers/deferred";

// The production transport is an external ESM package. Update Node's live builtin bindings too.
beforeAll(() => {
  vi.spyOn(dns, "lookup").mockImplementation(fake.lookup);
  vi.spyOn(https, "request").mockImplementation(fake.request);
  syncBuiltinESMExports();
});

describe("shared CIMD transport admission", () => {
  it("shares a bounded in-flight fetch without sharing a subscriber's cancellation", async () => {
    const ready = deferred();
    const upstream = vi.fn(async () => { await ready.promise; return Response.json({ ok: true }); });
    const transport = sharedMetadataFetch(upstream);
    const cancel = new AbortController();
    const one = transport("https://a.example/one", { signal: cancel.signal });
    const duplicate = sharedMetadataFetch(upstream)("https://a.example/one");
    const additional = [2, 3, 4].map(index => transport(`https://a.example/${index}`));
    const otherOrigin = [1, 2, 3, 4].map(index => transport(`https://b.example/${index}`));
    try {
      await expect(transport("https://a.example/overflow")).rejects.toBeInstanceOf(MetadataFetchBusy);
      await expect(transport("https://c.example/overflow")).rejects.toBeInstanceOf(MetadataFetchBusy);
      expect(upstream).toHaveBeenCalledTimes(8);
      const cancelled = expect(one).rejects.toMatchObject({ name: "AbortError" });
      cancel.abort();
      await cancelled;
    } finally {
      ready.resolve();
      await Promise.allSettled([one, duplicate, ...additional, ...otherOrigin]);
    }
    expect(await (await duplicate).json()).toEqual({ ok: true });
  });

  it("limits distinct resource lookups in the same origin even when none is still active", async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 404 }));
    const transport = sharedMetadataFetch(upstream);
    for (let index = 0; index < 30; index++) {
      expect((await transport(`https://a.example/${index}`)).status).toBe(404);
    }
    await expect(transport("https://a.example/extra")).rejects.toBeInstanceOf(MetadataFetchBusy);
    expect(upstream).toHaveBeenCalledTimes(30);
    expect((await transport("https://b.example/available")).status).toBe(404);
  });

  it("bounds the buffered body and cancels a stalled stream", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
      cancel: cancelled,
    });
    const oversized = sharedMetadataFetch(async () => new Response(body));
    await expect(oversized("https://a.example/large")).rejects.toThrow("too large");
    expect(cancelled).toHaveBeenCalledOnce();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const cancelled = vi.fn();
      const stalled = sharedMetadataFetch(async () => new Response(new ReadableStream({ cancel: cancelled })));
      const timedOut = expect(stalled("https://a.example/slow")).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(3000);
      await timedOut;
      expect(cancelled).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("aborts the underlying fetch when its last subscriber cancels", async () => {
    const started = deferred<AbortSignal>();
    const stopped = deferred();
    const upstream: MetadataFetch = async (_input, init) => {
      const signal = init!.signal!;
      started.resolve(signal);
      await stopped.promise;
      signal.throwIfAborted();
      return Response.json({});
    };
    const cancel = new AbortController();
    const result = expect(sharedMetadataFetch(upstream)("https://a.example/client", { signal: cancel.signal })).rejects.toMatchObject({ name: "AbortError" });
    const fetchSignal = await started.promise;
    cancel.abort();
    try {
      await result;
      expect(fetchSignal.aborted).toBe(true);
    } finally { stopped.resolve(); }
  });

  it("fetches only after the transaction attempt ends and caps follow-up resources", async () => {
    let inside = false;
    const upstream = vi.fn(async () => {
      expect(inside).toBe(false);
      return Response.json({});
    });
    const urls = [1, 2, 3].map(index => `https://client.example/${index}`);
    await expect(withPreparedMetadata(upstream, new AbortController().signal, async (fetch, requirePrepared) => {
      inside = true;
      try {
        for (const url of urls) await fetch(url);
      } catch {
        // The provider can translate a transport failure to its own response.
      } finally {
        inside = false;
        requirePrepared();
      }
    })).rejects.toBeInstanceOf(MetadataFetchBusy);
    expect(upstream.mock.calls).toHaveLength(2);
  });
});
afterAll(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

beforeEach(() => { fake.lookup.mockReset(); fake.request.mockReset(); });
describe("CIMD production HTTPS transport", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"])("rejects reserved destination %s before connecting", async (address) => {
    fake.lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
    await expect(fetchClientMetadataResource("https://clients.example.net/client.json")).rejects.toThrow("public-routable");
    expect(fake.request).not.toHaveBeenCalled();
  });
  it("rejects any private answer in a mixed DNS response", async () => {
    fake.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(fetchClientMetadataResource("https://clients.example.net/client.json")).rejects.toThrow("public-routable");
    expect(fake.request).not.toHaveBeenCalled();
  });
  it("resolves once, pins the validated address, preserves TLS hostname and refuses redirects", async () => {
    fake.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    fake.request.mockImplementation((_url, _options, callback) => {
      const socket = new EventEmitter() as EventEmitter & { end(): void };
      socket.end = () => {
        const response = Object.assign(Readable.from([]), { statusCode: 302, headers: { location: "https://127.0.0.1/private" }, statusMessage: "Found" });
        callback(response);
      };
      return socket;
    });
    const response = await fetchClientMetadataResource("https://clients.example.net/client.json");
    expect(response.status).toBe(302);
    expect(fake.lookup).toHaveBeenCalledTimes(1);
    expect(fake.request).toHaveBeenCalledTimes(1);
    const options = fake.request.mock.calls[0][1];
    expect(options).toMatchObject({ agent: false, servername: "clients.example.net", headers: { host: "clients.example.net" } });
    const done = vi.fn();
    options.lookup("rebind.invalid", { all: true }, done);
    expect(done).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
    expect(fake.lookup).toHaveBeenCalledTimes(1);
  });
  it("rejects non-HTTPS fetches", async () => {
    await expect(fetchClientMetadataResource("http://clients.example.net/client.json")).rejects.toThrow("HTTPS");
    expect(fake.lookup).not.toHaveBeenCalled();
  });
  it("bounds stalled DNS without attempting a connection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fake.lookup.mockReturnValue(new Promise(() => {}));
      const request = fetchMcpClientMetadata("https://clients.example.net/stalled.json");
      const rejected = expect(request).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(3000);
      await rejected;
      expect(fake.lookup).toHaveBeenCalledTimes(1);
      expect(fake.request).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
