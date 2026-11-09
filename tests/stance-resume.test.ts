import { describe, expect, it } from "vitest";
import { consumeStanceResume, stanceResumeCookie, STANCE_RESUME_TTL_SECONDS } from "~/lib/stance-resume.server";

const now = Date.UTC(2026, 10, 1);
const options = { secret: "a-test-key-for-the-consent-handoff", now };
const request = (cookie = "", session = "first-session", path = "/t/12") => new Request(`https://example.com${path}`, { headers: { cookie: `__Secure-better-auth.session_token=${session}; ${cookie}` } });
const made = () => stanceResumeCookie(request(), "member", 12, "disagree", options)!;

describe("the temporary stance handoff", () => {
  it("encrypts a short-lived, path-scoped, HttpOnly cookie and clears it on consumption", () => {
    const value = made();
    expect(value).not.toContain("disagree");
    expect(value).toContain("Path=/t/12; HttpOnly; SameSite=Lax; Max-Age=180; Secure");
    const read = consumeStanceResume(request(value.split(";")[0]), "member", 12, true, options);
    expect(read.position).toBe("disagree");
    expect(read.headers.get("Set-Cookie")).toContain("Path=/t/12; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
    expect(consumeStanceResume(request(), "member", 12, true, options).position).toBeNull();
  });

  it("rejects another member, another session, another question, revoked consent and expiration", () => {
    const value = made().split(";")[0];
    for (const read of [
      consumeStanceResume(request(value), "other", 12, true, options),
      consumeStanceResume(request(value, "second-session"), "member", 12, true, options),
      consumeStanceResume(request(value, "first-session", "/t/13"), "member", 13, true, options),
      consumeStanceResume(request(value), "member", 12, false, options),
      consumeStanceResume(request(value), undefined, 12, true, options),
      consumeStanceResume(request(value), "member", 12, true, { ...options, now: now + STANCE_RESUME_TTL_SECONDS * 1000 }),
    ]) {
      expect(read.position).toBeNull();
      expect(read.headers.get("Set-Cookie")).toContain("Max-Age=0");
    }
  });

  it("rejects tampering, duplicates, and URL-only completion markers", () => {
    const value = made().split(";")[0];
    for (const changed of [value + "x", value.replace(/=(.)/, (_, first) => `=${first === "A" ? "B" : "A"}`), `${value}; ${value}`]) {
      expect(consumeStanceResume(request(changed), "member", 12, true, options).position).toBeNull();
    }
    expect(consumeStanceResume(request("", "first-session", "/t/12?stance_msg=consented&stance_choice=disagree&stance_q=12"), "member", 12, false, options).position).toBeNull();
    expect(stanceResumeCookie(new Request("https://example.com/settings/stances"), "member", 12, "agree", options)).toBeNull();
  });
});
