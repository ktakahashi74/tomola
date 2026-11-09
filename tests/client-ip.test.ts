import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientAddress, installSocketAddressHook, normalizeIp, trustedProxyHops } from "~/lib/http/client-ip.server";

describe("TRUSTED_PROXY_HOPS", () => {
  it("is 0 by default and accepts non-negative integers", () => {
    expect(trustedProxyHops({})).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "" })).toBe(0);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: " 1 " })).toBe(1);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "2" })).toBe(2);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "0" })).toBe(0);
  });

  it("refuses anything else instead of guessing", () => {
    for (const bad of ["-1", "1.5", "abc", "one", "1,2", "100", "0x1", "+1"]) {
      expect(() => trustedProxyHops({ TRUSTED_PROXY_HOPS: bad }), bad).toThrow("TRUSTED_PROXY_HOPS");
    }
  });
});

describe("normalizeIp", () => {
  it("keeps IPv4, unwraps IPv4-mapped IPv6 and rounds IPv6 to its /64", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("2001:DB8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(normalizeIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("reads IPv4-mapped IPv6 in every spelling as the IPv4 address, including the hex form", () => {
    for (const mapped of ["::ffff:127.0.0.1", "::FFFF:127.0.0.1", "::ffff:7f00:1", "::ffff:7f00:0001", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:ffff:127.0.0.1"]) {
      expect(normalizeIp(mapped), mapped).toBe("127.0.0.1");
    }
    expect(normalizeIp("::ffff:cb00:7114")).toBe("203.0.113.20");
    // Keep non-IPv4-mapped forms other than ::ffff: as IPv6.
    expect(normalizeIp("::fffe:7f00:1")).toBe("0:0:0:0::/64");
    expect(normalizeIp("64:ff9b::7f00:1")).toBe("64:ff9b:0:0::/64");
  });

  it("strips a port: 1.2.3.4:5678, [2001:db8::1]:5678 and [2001:db8::1]", () => {
    expect(normalizeIp("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normalizeIp("[2001:db8:1:2::9]:443")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("[2001:db8:1:2::9]")).toBe("2001:db8:1:2::/64");
    expect(normalizeIp("[::ffff:7f00:1]:80")).toBe("127.0.0.1");
    for (const bad of ["203.0.113.7:", "203.0.113.7:99999999", "[2001:db8::1", "2001:db8::1]:80", "[::1]:x"]) expect(normalizeIp(bad), bad).toBeNull();
  });

  it("rejects anything that is not an IP address", () => {
    for (const bad of ["", "unknown", "1.2.3", "999.1.1.1", "<script>", "1.2.3.4, 5.6.7.8"]) expect(normalizeIp(bad), bad).toBeNull();
  });
});

describe("clientAddress with X-Forwarded-For", () => {
  const headers = (xff: string | null) => new Headers(xff === null ? {} : { "x-forwarded-for": xff });

  it("ignores X-Forwarded-For when no proxy is trusted (hops 0)", () => {
    expect(clientAddress(headers("1.2.3.4"), { hops: 0 })).toBeNull();
    expect(clientAddress(new Request("http://x/", { headers: headers("1.2.3.4") }), { hops: 0 })).toBeNull();
  });

  it("takes the Nth entry from the right, so entries the client added on the left do not count", () => {
    expect(clientAddress(headers("198.51.100.9"), { hops: 1 })).toBe("198.51.100.9");
    expect(clientAddress(headers("6.6.6.6, 198.51.100.9"), { hops: 1 })).toBe("198.51.100.9");
    expect(clientAddress(headers("6.6.6.6, 198.51.100.9, 10.0.0.2"), { hops: 2 })).toBe("198.51.100.9");
    expect(clientAddress(headers("198.51.100.9, 10.0.0.2"), { hops: 2 })).toBe("198.51.100.9");
    expect(clientAddress(headers("2001:db8::5"), { hops: 1 })).toBe("2001:db8:0:0::/64");
  });

  it("falls back to the socket address (none here) when the header is too short or not an address", () => {
    expect(clientAddress(headers(null), { hops: 1 })).toBeNull();
    expect(clientAddress(headers("198.51.100.9"), { hops: 2 })).toBeNull();
    expect(clientAddress(headers("not-an-ip"), { hops: 1 })).toBeNull();
    expect(clientAddress(headers(", ,"), { hops: 1 })).toBeNull();
  });

  it("reads a proxy's ip:port and bracketed entries", () => {
    expect(clientAddress(headers("6.6.6.6, 198.51.100.9:50123"), { hops: 1 })).toBe("198.51.100.9");
    expect(clientAddress(headers("[2001:db8:1:2::9]:443"), { hops: 1 })).toBe("2001:db8:1:2::/64");
    expect(clientAddress(headers("::ffff:c633:6409"), { hops: 1 })).toBe("198.51.100.9");
  });

  it("reads several X-Forwarded-For headers as one list", () => {
    const h = new Headers();
    h.append("x-forwarded-for", "6.6.6.6");
    h.append("x-forwarded-for", "198.51.100.9");
    expect(clientAddress(h, { hops: 1 })).toBe("198.51.100.9");
  });

  it("uses TRUSTED_PROXY_HOPS from the environment by default", () => {
    const original = process.env.TRUSTED_PROXY_HOPS;
    try {
      process.env.TRUSTED_PROXY_HOPS = "1";
      expect(clientAddress(headers("198.51.100.9"))).toBe("198.51.100.9");
      delete process.env.TRUSTED_PROXY_HOPS;
      expect(clientAddress(headers("198.51.100.9"))).toBeNull();
    } finally {
      if (original === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = original;
    }
  });
});

describe("X-Forwarded-For with no trusted proxy", () => {
  const originalHops = process.env.TRUSTED_PROXY_HOPS;
  beforeEach(() => {
    delete (globalThis as { __tomolaForwardedWarning?: boolean }).__tomolaForwardedWarning;
  });
  afterEach(() => {
    delete (globalThis as { __tomolaForwardedWarning?: boolean }).__tomolaForwardedWarning;
    if (originalHops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = originalHops;
    vi.restoreAllMocks();
  });

  it("warns once per process that the header is ignored (a proxy in front with TRUSTED_PROXY_HOPS unset shares one address)", () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = (xff?: string) => new Request("http://x/", { headers: xff ? { "x-forwarded-for": xff } : {} });
    clientAddress(request());
    expect(warn).not.toHaveBeenCalled();
    clientAddress(request("198.51.100.9"));
    clientAddress(request("198.51.100.10"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("TRUSTED_PROXY_HOPS");
  });

  it("does not warn when a proxy is trusted, or when the caller passes the setting itself", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TRUSTED_PROXY_HOPS = "1";
    clientAddress(new Request("http://x/", { headers: { "x-forwarded-for": "198.51.100.9" } }));
    clientAddress(new Request("http://x/", { headers: { "x-forwarded-for": "198.51.100.9" } }), { hops: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the socket address of a real connection", () => {
  it("is put on the request by the diagnostics channel hook, and a client cannot forge it", async () => {
    installSocketAddressHook();
    installSocketAddressHook(); // Calling twice subscribes only once.
    const seen: Headers[] = [];
    const server = http.createServer((req, res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      seen.push(headers);
      res.end(JSON.stringify({ direct: clientAddress(headers, { hops: 0 }), proxied: clientAddress(headers, { hops: 1 }) }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      // Direct connection uses the socket address. At hops=0 ignore X-Forwarded-For and overwrite forged internal headers.
      const plain = (await (await fetch(url, { headers: { "x-forwarded-for": "9.9.9.9", "x-tomola-socket-address": "forged:1.1.1.1" } })).json()) as { direct: string; proxied: string };
      expect(plain.direct).toBe("127.0.0.1");
      expect(plain.proxied).toBe("9.9.9.9");
      // Internal header values contain randomness; forged values do not remain.
      expect(seen[0].get("x-tomola-socket-address")).not.toContain("forged");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("a header forged without the hook in the way (wrong secret) is ignored", () => {
    const headers = new Headers({ "x-tomola-socket-address": "0123456789abcdef:1.1.1.1" });
    expect(clientAddress(headers, { hops: 0 })).toBeNull();
  });
});
