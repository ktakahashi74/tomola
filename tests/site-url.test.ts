import { describe, expect, it } from "vitest";
import { DEV_SITE_URL, inviteUrl, siteUrl } from "~/lib/site-url";

// The public site base URL (app/lib/site-url.ts) is shared by invitation URLs, Better Auth, origin checks, and external-image classification.
describe("siteUrl", () => {
  it("is BETTER_AUTH_URL without trailing slashes or spaces", () => {
    expect(siteUrl({ NODE_ENV: "production", BETTER_AUTH_URL: " https://forum.example.org/ " })).toBe("https://forum.example.org");
    expect(siteUrl({ NODE_ENV: "production", BETTER_AUTH_URL: "https://forum.example.org//" })).toBe("https://forum.example.org");
    expect(siteUrl({ NODE_ENV: "production", BETTER_AUTH_URL: "https://forum.example.org:8443" })).toBe("https://forum.example.org:8443");
  });

  it("defaults to the local development address in development and test, and is required in production", () => {
    expect(DEV_SITE_URL).toBe("http://localhost:5173");
    for (const NODE_ENV of ["development", "test"]) expect(siteUrl({ NODE_ENV })).toBe(DEV_SITE_URL);
    expect(() => siteUrl({ NODE_ENV: "production" })).toThrow("BETTER_AUTH_URL is required");
    expect(() => siteUrl({})).toThrow("BETTER_AUTH_URL is required");
    expect(() => siteUrl({ NODE_ENV: "production", BETTER_AUTH_URL: "  " })).toThrow("BETTER_AUTH_URL is required");
  });
});

describe("inviteUrl", () => {
  it("is the site URL, /invite/ and the token, with one slash however BETTER_AUTH_URL is written", () => {
    expect(inviteUrl("tok", { NODE_ENV: "production", BETTER_AUTH_URL: "https://forum.example.org/" })).toBe("https://forum.example.org/invite/tok");
    expect(inviteUrl("tok", { NODE_ENV: "test" })).toBe("http://localhost:5173/invite/tok");
  });
});
