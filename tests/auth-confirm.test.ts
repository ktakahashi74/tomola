import { m } from "~/paraglide/messages.js";
import { createElement } from "react";
import { renderInRouter } from "./helpers/render-in-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { rateLimits, session, user, verification } from "~/lib/db/schema";
import { hashMagicLinkToken } from "~/lib/auth/plugins";
import { magicLinkOwnerHash, magicLinkUsedIdentifier } from "~/lib/auth/complete-magic-link.server";
import { getSessionUser } from "~/lib/auth/session.server";
import { browserBindingIdentifier } from "~/lib/auth/magic-link-browser.server";
import { confirmUrl } from "~/lib/auth/magic-link.server";
import { createProfile } from "~/lib/profiles.server";
import AuthConfirm, { action, loader } from "~/routes/auth-confirm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import en from "../messages/en.json";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

// /auth/confirm: GET does not consume the token. POST consumes it, sets a cookie and redirects; a second attempt fails.
let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
});
afterAll(() => h.restore());

const post = (token: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  h.request("/auth/confirm", { form: { token, ...extra }, headers: { cookie: h.linkCookie(token), ...headers } });
const get = (token: string, extra = "", cookie = h.linkCookie(token)) => h.request(`/auth/confirm?token=${token}${extra}`, { headers: { cookie } });

describe("confirm page", () => {
  it("GET without the requesting browser returns no token, changes no rows, and sets no cookies", async () => {
    const token = await h.issueLink("scanner@example.com");
    const before = await h.db.select().from(verification);
    const limits = await h.db.select().from(rateLimits);
    for (let n = 0; n < 3; n++) {
      const page = await loader(h.args(get(token, "", ""))) as unknown as { data: { token: string | null }; init: { headers: Record<string, string> } };
      expect(page.data.token).toBeNull();
      expect(new Headers(page.init.headers).get("set-cookie")).toBeNull();
      expect(new Headers(page.init.headers).get("x-robots-tag")).toBe("noindex");
    }
    expect(await h.db.select().from(verification)).toEqual(before);
    expect(await h.db.select().from(rateLimits)).toEqual(limits);
    expect(((await action(h.args(post(token)))) as Response).status).toBe(303);
  });

  it("GET hides the token for another browser, expired and used links, and unknown tokens", async () => {
    const token = await h.issueLink("get-binding@example.com");
    const other = await h.issueLink("get-other@example.com");
    const expired = await h.issueLink("get-expired@example.com");
    const used = await h.issueLink("get-used@example.com");
    await action(h.args(post(used)));
    await h.db.update(verification).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(expired)}`));
    for (const [value, cookie, reason] of [[token, h.linkCookie(other), "other-browser"], [expired, h.linkCookie(expired), "expired"], [used, h.linkCookie(used), "used"], ["x".repeat(32), h.linkCookie(token), "unknown"]]) {
      expect((await loader(h.args(get(value, "", cookie))) as unknown as { data: unknown }).data).toEqual({ token: null, minutes: 15, reason });
      const failed = await h.outcome(() => action(h.args(post(value, {}, { cookie }))));
      expect(failed.status).toBe(400);
      expect(failed.value).toMatchObject({ data: { status: "invalid", reason } });
    }
    expect(((await action(h.args(post(token)))) as Response).status).toBe(303);
  });

  it("GET shows the form without using the token, and excludes the token from Referer", async () => {
    const token = await h.issueLink("ann@example.com");
    for (let i = 0; i < 3; i++) {
      const result = (await loader(h.args(get(token)))) as unknown as { data: { token: string | null }; init: { headers: Record<string, string> } };
      expect(result.data.token).toBe(token);
      expect(result.init.headers).toMatchObject({ "Cache-Control": "no-store", "Referrer-Policy": "strict-origin" });
    }
    // Repeated page visits leave it usable and create neither users nor sessions.
    expect(await h.db.select().from(user).where(eq(user.email, "ann@example.com"))).toHaveLength(0);
    const res = await h.outcome(() => action(h.args(post(token))));
    expect(res.status).toBe(303);
  });

  it("POST verifies the token, forwards the session cookie and sends a new member to onboarding", async () => {
    const token = await h.issueLink("bob@example.com");
    const res = (await action(h.args(post(token, {}, { cookie: `${h.linkCookie(token)}; tomola.reading-return=%2Ft%2F42` })))) as Response;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/onboarding");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => /session_token=/.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith("tomola.reading-return="))).toBe(false);
    const [u] = await h.db.select().from(user).where(eq(user.email, "bob@example.com"));
    expect(await h.db.select().from(session).where(eq(session.userId, u.id))).toHaveLength(1);
  });

  it("carries a new member's stored return path to onboarding and rejects external paths", async () => {
    for (const [next, expected] of [["/t/5?lang=en#reply", "/t/5?lang=en#reply"], ["//evil.example/", "/"], ["https://evil.example/", "/"]]) {
      const token = await h.issueLink(`return-${expected === "/" ? next.length : "local"}@example.com`, next);
      const res = await action(h.args(post(token))) as Response;
      const destination = new URL(res.headers.get("location")!, "http://localhost");
      expect(destination.pathname).toBe("/onboarding");
      expect(destination.searchParams.get("next") ?? "/").toBe(expected);
    }
  });

  it("a second POST with the same token fails (single use)", async () => {
    const token = await h.issueLink("cara@example.com");
    const first = (await action(h.args(post(token)))) as Response;
    expect(first.status).toBe(303);
    const second = await h.outcome(() => action(h.args(post(token))));
    expect(second.status).toBe(400);
    expect(second.value).toMatchObject({ data: { status: "invalid", reason: "used" } });
    const [u] = await h.db.select().from(user).where(eq(user.email, "cara@example.com"));
    expect(await h.db.select().from(session).where(eq(session.userId, u.id))).toHaveLength(1);
  });

  it("an unknown, malformed or empty token is invalid without touching anything", async () => {
    for (const token of ["", "x", "a".repeat(32), "../../etc/passwd", "a".repeat(500)]) {
      const res = await h.outcome(() => action(h.args(post(token))));
      expect(res.status, token).toBe(400);
      expect(res.value).toMatchObject({ data: { status: "invalid", reason: "unknown" } });
    }
    const page = (await loader(h.args(get("short")))) as unknown as { data: { token: string | null } };
    expect(page.data.token).toBeNull();
  });

  it("sends an existing member home, or to a safe local path, and never off the site", async () => {
    const t1 = await h.issueLink("dan@example.com");
    const first = (await action(h.args(post(t1)))) as Response;
    const [u] = await h.db.select().from(user).where(eq(user.email, "dan@example.com"));
    await createProfile(h.db, u.id, { handle: "dan", homeArea: "ja", readLangs: ["ja"] });
    expect(first.headers.get("location")).toBe("/onboarding");
    const t2 = await h.issueLink("dan@example.com");
    const returning = await action(h.args(post(t2, {}, { cookie: `${h.linkCookie(t2)}; tomola.reading-return=%2Ft%2F42` }))) as Response;
    expect(returning.headers.get("location")).toBe("/");
    expect(returning.headers.getSetCookie()).toContain("tomola.reading-return=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    const t3 = await h.issueLink("dan@example.com", "/t/5?page=2");
    expect(((await action(h.args(post(t3, { next: "/tampered" })))) as Response).headers.get("location")).toBe("/t/5?page=2");
    for (const next of ["https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const t = await h.issueLink("dan@example.com", next);
      expect(((await action(h.args(post(t, { next })))) as Response).headers.get("location"), next).toBe("/");
    }
  });

  it("POST from another origin is refused before the token is used", async () => {
    const token = await h.issueLink("eve@example.com");
    const res = await h.outcome(() => action(h.args(post(token, {}, { origin: "https://evil.example" }))));
    expect(res.status).toBe(403);
    // The token remains unused, so a same-origin POST succeeds.
    expect(((await action(h.args(post(token)))) as Response).status).toBe(303);
  });

  it("refuses an attacker's valid link in another browser without consuming it or creating a session", async () => {
    const attacker = await h.issueLink("attacker@example.com");
    const victim = await h.issueLink("victim@example.com");
    const before = await h.db.select().from(session);
    for (const cookie of ["", h.linkCookie(victim), h.linkCookie(attacker) + "; " + h.linkCookie(victim)]) {
      const res = await h.outcome(() => action(h.args(post(attacker, {}, { cookie }))));
      expect(res.status).toBe(400);
    }
    expect(await h.db.select().from(session)).toHaveLength(before.length);
    expect(((await action(h.args(post(attacker)))) as Response).status).toBe(303);
  });

  it("offers another-browser recovery without consuming the original token or revealing next", async () => {
    const token = await h.issueLink("recovery@example.com");
    const result = await action(h.args(post(token, {}, { cookie: "" })));
    expect(result).toMatchObject({ data: { status: "invalid" }, init: { status: 400 } });
    const html = await renderInRouter(() => createElement(AuthConfirm, { loaderData: { token, reason: "usable", minutes: 15 }, actionData: { status: "invalid", reason: "other-browser" }, params: {}, matches: [] } as never), "/auth/confirm");
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="email"');
    expect(html).not.toContain('name="next"');
    expect(html).toContain(en.confirm_unusable_heading);
    expect(html).toContain(en.confirm_invalid_hint);
    expect(((await action(h.args(post(token)))) as Response).status).toBe(303);
  });

  it("requires an unexpired binding, including for links issued before the change", async () => {
    const legacy = await h.issueLink("legacy@example.com");
    await h.db.delete(verification).where(eq(verification.identifier, browserBindingIdentifier(legacy)));
    expect((await h.outcome(() => action(h.args(post(legacy))))).status).toBe(400);
    const expired = await h.issueLink("expired-binding@example.com");
    await h.db.update(verification).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(verification.identifier, browserBindingIdentifier(expired)));
    expect((await h.outcome(() => action(h.args(post(expired))))).status).toBe(400);
  });

  it("retains only hashed ownership in a success marker until 24 hours after the original link expiry", async () => {
    const token = await h.issueLink("marker@example.com", "/settings?private=destination");
    const [credential] = await h.db.select().from(verification).where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(token)}`));
    await action(h.args(post(token, {}, { cookie: "" })));
    expect(await h.db.select().from(verification).where(eq(verification.identifier, magicLinkUsedIdentifier(token)))).toHaveLength(0);
    await action(h.args(post(token)));
    const [marker] = await h.db.select().from(verification).where(eq(verification.identifier, magicLinkUsedIdentifier(token)));
    expect(marker.identifier).toBe(`magic-link-used:${hashMagicLinkToken(token)}`);
    expect(marker.expiresAt.getTime()).toBe(credential.expiresAt.getTime() + 86_400_000);
    const [member] = await h.db.select().from(user).where(eq(user.email, "marker@example.com"));
    expect(marker.value).toBe(magicLinkOwnerHash(member.id));
    for (const privateValue of [token, member.email, member.id, "/settings?private=destination"]) expect(JSON.stringify(marker)).not.toContain(privateValue);
    await h.db.update(verification).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(verification.id, marker.id));
    expect(await loader(h.args(get(token)))).toMatchObject({ data: { token: null, reason: "unknown" } });
  });

  it("marks only the successful concurrent confirmation and reports the losing POST as used", async () => {
    const token = await h.issueLink("concurrent-confirm@example.com");
    const results = await Promise.all([h.outcome(() => action(h.args(post(token)))), h.outcome(() => action(h.args(post(token))))]);
    expect(results.map(result => result.status).sort()).toEqual([303, 400]);
    expect(results.find(result => result.status === 400)?.value).toMatchObject({ data: { reason: "used" } });
    expect(await h.db.select().from(verification).where(eq(verification.identifier, magicLinkUsedIdentifier(token)))).toHaveLength(1);
    const [member] = await h.db.select().from(user).where(eq(user.email, "concurrent-confirm@example.com"));
    expect(await h.db.select().from(session).where(eq(session.userId, member.id))).toHaveLength(1);
  });

  it("redirects only unusable links known to belong to the signed-in member", async () => {
    await h.signIn("confirm_signed_in");
    const signedCookie = h.request("/", { as: "confirm_signed_in" }).headers.get("cookie")!;
    const used = await h.issueLink("confirm_signed_in@example.com");
    await action(h.args(post(used)));
    const expired = await h.issueLink("confirm_signed_in@example.com");
    const otherBrowser = await h.issueLink("confirm_signed_in@example.com");
    await h.db.update(verification).set({ expiresAt: new Date(Date.now() - 1), value: JSON.stringify({ type: "magic-link", email: "CONFIRM_SIGNED_IN@EXAMPLE.COM" }) }).where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(expired)}`));
    for (const token of [used, expired]) {
      for (const run of [() => loader(h.args(get(token, "", signedCookie))), () => action(h.args(post(token, {}, { cookie: signedCookie })))]) {
        expect(await h.outcome(run)).toMatchObject({ status: 302, location: "/" });
      }
    }
    // A link that only fails the browser binding gets one answer for everyone, the member it belongs to included: sending only that member on would show whose link it is.
    expect(await loader(h.args(get(otherBrowser, "", signedCookie)))).toMatchObject({ data: { token: null, reason: "other-browser" } });
    expect(await h.outcome(() => action(h.args(post(otherBrowser, {}, { cookie: signedCookie }))))).toMatchObject({ status: 400, value: { data: { reason: "other-browser" } } });
    expect(await loader(h.args(get(otherBrowser, "", "")))).toMatchObject({ data: { token: null, reason: "other-browser" } });
  });

  it("answers an other-browser link the same for no one, the owner and another member, without reading the return path", async () => {
    await h.signIn("confirm_other_a");
    await h.signIn("confirm_other_b");
    const token = await h.issueLink("confirm_other_a@example.com", "/settings/connections?secret=1");
    const before = await h.db.select().from(verification).where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(token)}`));
    const answers: unknown[] = [];
    for (const as of [undefined, "confirm_other_a", "confirm_other_b"]) {
      const cookie = as ? h.request("/", { as }).headers.get("cookie")! : "";
      const page = await loader(h.args(get(token, "", cookie)));
      answers.push(JSON.stringify(page));
      const posted = await h.outcome(() => action(h.args(post(token, { next: "https://evil.example/" }, { cookie }))));
      answers.push(JSON.stringify(posted));
    }
    expect(new Set([answers[0], answers[2], answers[4]]).size).toBe(1);
    expect(new Set([answers[1], answers[3], answers[5]]).size).toBe(1);
    expect(answers.join()).not.toContain("secret");
    expect(answers.join()).not.toContain("evil.example");
    // Opening the page and the refused POST used nothing.
    expect(await h.db.select().from(verification).where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(token)}`))).toEqual(before);
  });

  it("shows reasons for another member's links and unknown ownership even while signed in", async () => {
    const signedCookie = h.request("/", { as: "confirm_signed_in" }).headers.get("cookie")!;
    const used = await h.issueLink("foreign-owner@example.com");
    await action(h.args(post(used)));
    const legacy = await h.issueLink("confirm_signed_in@example.com");
    await action(h.args(post(legacy)));
    await h.db.update(verification).set({ value: "" }).where(eq(verification.identifier, magicLinkUsedIdentifier(legacy)));
    const expired = await h.issueLink("foreign-expired@example.com");
    const unreadable = await h.issueLink("confirm_signed_in@example.com");
    const otherBrowser = await h.issueLink("foreign-browser@example.com");
    for (const token of [expired, unreadable]) await h.db.update(verification).set({ expiresAt: new Date(Date.now() - 1), ...(token === unreadable ? { value: "not-json" } : {}) }).where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(token)}`));
    for (const [token, reason] of [[used, "used"], [legacy, "used"], [expired, "expired"], [unreadable, "expired"], [otherBrowser, "other-browser"], ["a".repeat(32), "unknown"], ["bad", "unknown"]]) {
      expect(await loader(h.args(get(token, "", signedCookie)))).toMatchObject({ data: { token: null, reason } });
      const response = await h.outcome(() => action(h.args(post(token, {}, { cookie: signedCookie }))));
      expect(response).toMatchObject({ status: 400, value: { data: { reason } } });
      expect(JSON.stringify(response.value)).not.toContain(signedCookie);
      expect(JSON.stringify(response.value)).not.toContain("@example.com");
      expect(JSON.stringify(response.value)).not.toContain(magicLinkOwnerHash(h.ids.confirm_signed_in));
    }
  });

  it("keeps another member's usable button and replaces the browser session on confirmation", async () => {
    await h.signIn("confirm_target");
    const signedCookie = h.request("/", { as: "confirm_signed_in" }).headers.get("cookie")!;
    const usable = await h.issueLink("confirm_target@example.com");
    const cookie = `${signedCookie}; ${h.linkCookie(usable)}`;
    expect(await loader(h.args(get(usable, "", cookie)))).toMatchObject({ data: { token: usable, reason: "usable" } });
    const result = await action(h.args(post(usable, {}, { cookie }))) as Response;
    expect(result.headers.get("location")).toBe("/");
    const newCookie = result.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    expect((await getSessionUser(h.request("/", { headers: { cookie: newCookie } })))?.id).toBe(h.ids.confirm_target);
    expect((await getSessionUser(h.request("/", { as: "confirm_signed_in" })))?.id).toBe(h.ids.confirm_signed_in);
  });

  it("renders every failure and its recovery form on the server without revealing a token", async () => {
    for (const [reason, heading, body] of [
      ["used", en.confirm_used_heading, en.confirm_used],
      ["expired", en.confirm_expired_heading, m.confirm_expired({ minutes: 15 })],
      ["other-browser", en.confirm_unusable_heading, en.confirm_invalid_hint],
      ["unknown", en.confirm_unknown_heading, m.confirm_invalid({ minutes: 15 })],
    ]) {
      const html = await renderInRouter(() => createElement(AuthConfirm, { loaderData: { token: null, reason, minutes: 15 }, params: {}, matches: [] } as never), "/auth/confirm");
      expect(html).toContain(heading);
      expect(html).toContain(body);
      expect(html).toContain('action="/login"');
      expect(html).toContain('name="email"');
      expect(html).not.toContain('name="token"');
      expect(html).not.toContain('name="next"');
    }
  });
});

describe("the URL in the email", () => {
  it("points at the confirm page, not at Better Auth's verify endpoint", () => {
    expect(confirmUrl("http://localhost:5173", "abcDEF123")).toBe("http://localhost:5173/auth/confirm?token=abcDEF123");
    expect(confirmUrl("https://forum.example.org/", "tok")).toBe("https://forum.example.org/auth/confirm?token=tok");
    expect(confirmUrl("https://forum.example.org", "tok")).not.toContain("next=");
  });
});
