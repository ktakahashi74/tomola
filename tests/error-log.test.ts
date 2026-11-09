import { data, isRouteErrorResponse, UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeRequest, formatErrorLog, isQuietError, logServerError } from "~/lib/http/error-log.server";
import { handleError } from "../app/entry.server";
import { DrizzleQueryError } from "drizzle-orm";

// Server error logging: app/lib/http/error-log.server.ts and handleError in app/entry.server.tsx.
const req = (url: string, init?: RequestInit) => new Request(url, init);
const notFound = (url: string) => new ErrorResponseImpl(404, "Not Found", new Error(`No route matches URL "${url}"`), true);

it("omits query parameters and nested database error detail from direct and wrapped failures", () => {
  const query = "insert into entries (body, email, token, ip) values ($1, $2, $3, $4)";
  const secrets = ["private body", "private@example.com", "session-secret", "192.0.2.7"];
  const failure = new DrizzleQueryError(query, secrets, Object.assign(new Error(secrets.join(" ")), { code: "23505", detail: secrets.join(" ") }));
  for (const error of [failure, new Error(`wrapped: ${failure.message}`, { cause: failure }), new AggregateError([failure], "query failed")]) {
    const line = formatErrorLog(error, req("https://forum.example.org/settings"))!;
    expect(line).toContain(query);
    expect(line).toContain("23505");
    expect(line).not.toContain("params:");
    for (const secret of secrets) expect(line).not.toContain(secret);
  }
});

describe("which errors are logged", () => {
  it("does not log the 404 for a URL that matches no route, or the 405 for a method the route does not accept", () => {
    const request = req("https://forum.example.org/invite/SECRETTOKEN");
    expect(isQuietError(notFound("/invite/SECRETTOKEN"))).toBe(true);
    expect(formatErrorLog(notFound("/invite/SECRETTOKEN"), request)).toBeNull();
    const notAllowed = new ErrorResponseImpl(405, "Method Not Allowed", new Error('You made a POST request to "/search" but did not provide an `action`'), true);
    expect(formatErrorLog(notAllowed, req("https://forum.example.org/search", { method: "POST" }))).toBeNull();
  });

  it("logs everything else: a thrown Error, other error responses, and values that are not Errors", () => {
    const request = req("https://forum.example.org/topics/1");
    expect(formatErrorLog(new Error("boom"), request)).toMatch(/^\[error\] GET \/topics\/1\nError: boom\n\s+at /);
    const bad = new ErrorResponseImpl(400, "Bad Request", new Error("bad form"), true);
    expect(formatErrorLog(bad, request)).toContain("Error: bad form");
    expect(formatErrorLog(new ErrorResponseImpl(500, "Internal Server Error", "x"), request)).toContain("500 Internal Server Error");
    expect(formatErrorLog("a string", request)).toBe("[error] GET /topics/1\na string");
    expect(formatErrorLog({ code: 7 }, request)).toContain("code: 7");
    expect(isRouteErrorResponse(data("x", { status: 404 }))).toBe(false);
  });

  it("does not log an error of a request the client already abandoned", () => {
    const controller = new AbortController();
    const request = req("https://forum.example.org/topics/1", { signal: controller.signal });
    controller.abort();
    expect(formatErrorLog(new Error("aborted"), request)).toBeNull();
  });
});

describe("what a logged line says about the request", () => {
  it("names the method and the path, and hides the query string and invitation tokens (the redaction of the access log)", () => {
    expect(describeRequest(req("https://forum.example.org/search?q=cooperation&k=tml_secret", { method: "POST" }))).toBe("POST /search?[redacted]");
    expect(describeRequest(req("https://forum.example.org/auth/confirm?token=abc"))).toBe("GET /auth/confirm?[redacted]");
    expect(describeRequest(req("https://forum.example.org/latest.md?o=private-marker"))).toBe("GET /latest.md?[redacted]");
    expect(describeRequest(req("https://forum.example.org/invite/SECRETTOKEN"))).toBe("GET /invite/[redacted]");
    expect(describeRequest(req("https://forum.example.org/./invite/SECRETTOKEN"))).toBe("GET /invite/[redacted]");
  });

  it("hides the request's own URL when the message of the error contains it", () => {
    const request = req("https://forum.example.org/auth/confirm?token=SECRETTOKEN&next=/");
    const out = formatErrorLog(new Error("failed for https://forum.example.org/auth/confirm?token=SECRETTOKEN&next=/ (and /auth/confirm?token=SECRETTOKEN&next=/)"), request)!;
    expect(out).not.toContain("SECRETTOKEN");
    expect(out).toContain("[error] GET /auth/confirm?[redacted]");
    expect(out).toContain("https://forum.example.org/auth/confirm?[redacted]");
  });

  it("copes with a request URL it cannot parse", () => {
    const fake = { method: "GET", url: "not a url", signal: new AbortController().signal } as unknown as Request;
    expect(formatErrorLog(new Error("x"), fake)).toMatch(/^\[error\] GET \[unparsable URL\]\nError: x/);
  });
});

describe("handleError of the server entry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is exported, writes one console.error for a real error, and nothing for a 404", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = req("https://forum.example.org/topics/1?k=tml_secret");
    handleError(notFound("/topics/1"), { request, params: {}, context: undefined as never });
    expect(spy).not.toHaveBeenCalled();
    handleError(new Error("db down"), { request, params: {}, context: undefined as never });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain("[error] GET /topics/1?[redacted]");
    expect(line).toContain("db down");
    expect(line).not.toContain("tml_secret");
    logServerError(new Error("again"), request);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
