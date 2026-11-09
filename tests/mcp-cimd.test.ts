import { EventEmitter } from "node:events";
import dns from "node:dns/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { fetchMcpClientMetadata } from "~/lib/mcp/cimd.server";

// The production transport is an external ESM package. Update Node's live builtin bindings too.
beforeAll(() => {
  vi.spyOn(dns, "lookup").mockImplementation(fake.lookup);
  vi.spyOn(https, "request").mockImplementation(fake.request);
  syncBuiltinESMExports();
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
