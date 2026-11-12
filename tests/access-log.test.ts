import { describe, expect, it } from "vitest";
import { formatAccessLog, redactUrl, REDACTED } from "../server/access-log.ts";

// Production server.ts access logs omit URL parts that may contain secrets (server/access-log.ts).
describe("redactUrl", () => {
  it("hides every query string, including the signed-link, search and login-token parameters", () => {
    expect(redactUrl("/t/12.md?k=tml_signed_abcdef")).toBe(`/t/${REDACTED}?${REDACTED}`);
    expect(redactUrl("/search?q=my%20private%20question&lang=ja")).toBe(`/search?${REDACTED}`);
    expect(redactUrl("/search.md?q=x&k=secret")).toBe(`/search.md?${REDACTED}`);
    expect(redactUrl("/auth/confirm?token=abcDEF123")).toBe(`/auth/confirm?${REDACTED}`);
    expect(redactUrl("/changes.md?cursor=1790812800000_5&k=tok")).toBe(`/changes.md?${REDACTED}`);
    expect(redactUrl("/t/1?")).toBe(`/t/${REDACTED}?${REDACTED}`);
  });

  it("keeps ordinary paths without a query as they are", () => {
    expect(redactUrl("/")).toBe("/");
    expect(redactUrl("/stats")).toBe("/stats");
    expect(redactUrl("/assets/entry.client-abc.js")).toBe("/assets/entry.client-abc.js");
  });

  it("hides the token in an invitation URL", () => {
    expect(redactUrl("/invite/Zm9vYmFy0123456789")).toBe(`/invite/${REDACTED}`);
    expect(redactUrl("/invite/Zm9vYmFy0123456789?utm=x")).toBe(`/invite/${REDACTED}?${REDACTED}`);
  });

  it("hides it however the route may be reached: case, percent-encoding, repeated or backward slashes", () => {
    for (const url of ["/INVITE/secret", "/Invite/secret", "/%69nvite/secret", "/%2569nvite/secret", "//invite/secret", "/invite//secret", "/invite%2Fsecret", "/\\invite/secret"]) {
      const out = redactUrl(url);
      expect(out, url).not.toContain("secret");
      expect(out, url).toBe(`/invite/${REDACTED}`);
    }
  });

  it("hides it after resolving dot segments, as the router does: /./invite/t, /x/../invite/t, /%2e/invite/t, /%2e%2e/invite/t", () => {
    for (const url of [
      "/./invite/secret",
      "/x/../invite/secret",
      "/%2e/invite/secret",
      "/%2E/invite/secret",
      "/%2e%2e/invite/secret",
      "/a/b/../../invite/secret",
      "/a/%2e%2e/invite/secret",
      "/a/%2E%2E/%2e/invite/secret",
      "/%252e%252e/invite/secret",
      "/a/..%2finvite/secret",
      "/..\\invite/secret",
      "/invite/./secret",
      "/./INVITE/./secret",
      "invite/secret",
    ]) {
      const out = redactUrl(url);
      expect(out, url).not.toContain("secret");
      expect(out, url).toBe(`/invite/${REDACTED}`);
    }
    // Only redirects the route elsewhere; not an invitation.
    expect(redactUrl("/invite/../latest")).toBe("/invite/../latest");
    expect(redactUrl("/x/../latest")).toBe("/x/../latest");
    expect(redactUrl("/%2e/t/1")).toBe(`/t/${REDACTED}`);
  });

  it("does not hide other paths that only look similar", () => {
    expect(redactUrl("/invites/new")).toBe("/invites/new");
    expect(redactUrl("/admin/invitations")).toBe("/admin/invitations");
  });

  it("replaces control characters (no line breaks in the log) and cuts very long paths", () => {
    expect(redactUrl("/a%0d%0aGET /evil")).toBe("/a%0d%0aGET /evil");
    expect(redactUrl("/a\r\n[http] GET /fake 200")).toBe("/a??[http] GET /fake 200");
    const long = redactUrl(`/${"x".repeat(1000)}`);
    expect(long.length).toBeLessThan(210);
    expect(long.endsWith("…")).toBe(true);
  });

  it("does not throw on a malformed percent sequence", () => {
    expect(redactUrl("/%zz/%E0%A4%A")).toBe("/%zz/%E0%A4%A");
    expect(redactUrl("/invite/%E0%A4%A")).toBe(`/invite/${REDACTED}`);
  });
});

describe("formatAccessLog", () => {
  it("writes one line in the shape of morgan's tiny format, with the redacted URL", () => {
    expect(formatAccessLog({ method: "GET", url: "/search?q=secret", status: 200, bytes: 1234, ms: 12.3456 })).toBe(`[http] GET /search?${REDACTED} 200 1234 - 12.346 ms`);
    expect(formatAccessLog({ method: "POST", url: "/invite/tok", status: 303, bytes: null, ms: 0.5 })).toBe(`[http] POST /invite/${REDACTED} 303 - - 0.500 ms`);
  });

  it("does not let a request's method forge more log lines", () => {
    const line = formatAccessLog({ method: "GET\n[http] fake", url: "/", status: 400, bytes: 0, ms: 1 });
    expect(line.split("\n")).toHaveLength(1);
  });
});


it("redacts media IDs and dimension-bearing resource paths", () => {
  for (const url of ["/media/" + "a".repeat(64) + "-100x80.webp", "/MEDIA/secret", "/%6dedia/secret", "/x/../media/secret"]) {
    expect(redactUrl(url)).toBe(`/media/${REDACTED}`);
  }
});

it("redacts article identifiers on HTML, data, Markdown and browser-notification paths", () => {
  for (const url of ["/t/982", "/t/982.md", "/t/982.txt", "/t/982.data", "/t/982/translations", "/T/%39%38%32/translations", "/t//982/translations", "/x/../t/982"]) {
    expect(redactUrl(url)).toBe(`/t/${REDACTED}`);
  }
  expect(formatAccessLog({ method: "POST", url: "/t/982/translations?sl=en", status: 200, bytes: 11, ms: 1 })).not.toContain("982");
});
