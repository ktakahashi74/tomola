import { createElement } from "react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createAppAuth, getAuth } from "~/lib/auth/auth.server";
import { getSessionUser } from "~/lib/auth/session.server";
import { settleMagicLinkMail } from "~/lib/auth/magic-link.server";
import { prepareLoginCode } from "~/lib/auth/login-code-cookie.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { rateLimits, verification } from "~/lib/db/schema";
import { createInvitation } from "~/lib/invitations.server";
import { passkeyPromptPreference } from "~/lib/passkey-prompt.server";
import { PASSKEY_PROMPT_MAX_AGE } from "~/lib/passkey-prompt";
import { messageMarkup } from "./helpers/message-markup";
import { m } from "~/paraglide/messages.js";
import { action, loader } from "~/routes/login";
import MemberLayout, { loader as memberLoader } from "~/routes/member-layout";
import { handle as homeHandle } from "~/routes/home";
import { handle as settingsHandle } from "~/routes/settings";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("polish"); await h.signIn("polish_target"); });
afterAll(() => h.restore());

it.each(["", "login-resend", "login-code", "login-restart"])("redirects a member's %s action only for the same or unknown address", async intent => {
  const mail = vi.spyOn((await getAuth()).api, "signInMagicLink");
  try {
    const before = await h.db.select().from(verification);
    const limits = await h.db.select().from(rateLimits);
    for (const [next, expected] of [["/settings?from=login#keys", "/settings?from=login#keys"], ["https://elsewhere.example/", "/"], ["//elsewhere.example/", "/"], ["", "/"]]) {
      const pending = prepareLoginCode(h.request("/login"), "polish@example.com");
      for (const extra of ["", [pending.browser.cookie, pending.cookie, pending.emailCookie].map(value => value.split(";")[0]).join("; ")]) {
        const request = h.request("/login", { as: "polish", form: { intent, next, email: "POLISH@EXAMPLE.COM", code: "000000" } });
        if (extra) request.headers.set("cookie", `${request.headers.get("cookie")}; ${extra}`);
        expect(await h.outcome(() => action(h.args(request)))).toMatchObject({ status: 302, location: expected });
      }
    }
    expect(mail).not.toHaveBeenCalled();
    expect(await h.db.select().from(verification)).toEqual(before);
    expect(await h.db.select().from(rateLimits)).toEqual(limits);
  } finally { mail.mockRestore(); }
});

const box = createMemoryMailbox();
const actorCookie = () => h.request("/", { as: "polish" }).headers.get("cookie")!;
const cookieOf = (response: unknown) => (response instanceof Response ? response.headers : (response as { init: { headers: Headers } }).init.headers).getSetCookie().map(value => value.split(";")[0]).join("; ");
const switchingRequest = (form: Record<string, string>, cookie = actorCookie()) => h.request("/login?next=%2Fsettings", { form: { next: "/settings", ...form }, headers: { cookie } });
async function useSwitchingMailer() {
  (globalThis as { __tomolaAuth?: Promise<unknown> }).__tomolaAuth = Promise.resolve(createAppAuth(h.db, { baseURL: "http://localhost:5173", secret: "test-secret-0123456789abcdef0123456789abcdef", mailer: () => createMailer(box.transport, "test@example.org") }));
}

it("continues another address's code screen for both a member and an invited recipient", async () => {
  (await useSwitchingMailer());
  await createInvitation(h.db, { email: "polish_invited@example.com" });
  for (const email of ["polish_target@example.com", "polish_invited@example.com"]) {
    const before = box.sent.length;
    const sent = await action(h.args(switchingRequest({ email })));
    expect(sent).toMatchObject({ data: { status: "sent" } });
    const cookie = `${actorCookie()}; ${cookieOf(sent)}`;
    expect(await loader(h.args(h.request("/login?next=%2Fsettings", { headers: { cookie } })))).toMatchObject({ next: "/settings", codePending: { email, invalid: false, limited: null } });
    await settleMagicLinkMail();
    expect(box.sent.length - before).toBe(1);
    expect((await getSessionUser(h.request("/", { headers: { cookie } })))?.id).toBe(h.ids.polish);
  }
});

it("resends and restarts a different remembered address despite the existing session", async () => {
  (await useSwitchingMailer());
  const sent = await action(h.args(switchingRequest({ email: "polish_target@example.com" })));
  await settleMagicLinkMail();
  const before = box.sent.length;
  const cookie = `${actorCookie()}; ${cookieOf(sent)}`;
  const resend = await action(h.args(switchingRequest({ intent: "login-resend", email: "polish@example.com" }, cookie)));
  await settleMagicLinkMail();
  expect(box.sent.length).toBe(before + 1);
  expect(box.sent.at(-1)?.to).toBe("polish_target@example.com");
  const renewed = `${actorCookie()}; ${cookieOf(resend)}`;
  expect(await loader(h.args(h.request("/login", { headers: { cookie: renewed } })))).toMatchObject({ codePending: { email: "polish_target@example.com", resent: true } });
  const restart = await action(h.args(switchingRequest({ intent: "login-restart" }, renewed))) as Response;
  expect(restart.status).toBe(303);
  expect(restart.headers.getSetCookie().every(value => value.includes("Max-Age=0"))).toBe(true);
  expect(await h.outcome(async () => (await loader(h.args(h.request("/login?next=%2Fsettings", { headers: { cookie: actorCookie() } })))))).toMatchObject({ status: 302, location: "/settings" });
});

it("uses a different remembered address's code to replace the current browser session", async () => {
  (await useSwitchingMailer());
  const sent = await action(h.args(switchingRequest({ email: "polish_target@example.com" })));
  await settleMagicLinkMail();
  const code = box.sent.at(-1)!.text.match(/\b(\d{3}) (\d{3})\b/)!;
  const cookie = `${actorCookie()}; ${cookieOf(sent)}`;
  const complete = await action(h.args(switchingRequest({ intent: "login-code", code: code[1] + code[2], email: "polish@example.com" }, cookie))) as Response;
  expect(complete.status).toBe(303);
  expect(complete.headers.get("location")).toBe("/settings");
  expect((await getSessionUser(h.request("/", { headers: { cookie: cookieOf(complete) } })))?.id).toBe(h.ids.polish_target);
});

it("keeps origin validation ahead of the member redirect", async () => {
  const result = await h.outcome(() => action(h.args(h.request("/login", { as: "polish", form: { next: "/settings" }, headers: { origin: "https://elsewhere.example" } }))));
  expect(result.status).toBe(403);
});

it("defers only the same member for at most thirty days without identifying cookie values", () => {
  const now = 1_800_000_000_000;
  const request = (cookie = "", secure = false) => new Request(`${secure ? "https" : "http"}://localhost/`, { headers: { cookie } });
  const { cookieName } = passkeyPromptPreference(request(), "member-a", now);
  const until = now + PASSKEY_PROMPT_MAX_AGE * 1000;
  const cookie = `${cookieName}=${until}`;
  expect(cookie).not.toContain("member-a");
  expect(passkeyPromptPreference(request(cookie), "member-a", now).deferred).toBe(true);
  expect(passkeyPromptPreference(request(cookie), "member-b", now).deferred).toBe(false);
  expect(passkeyPromptPreference(request(cookie), "member-a", until).deferred).toBe(false);
  for (const value of ["", "invalid", "Infinity", String(until + 1)]) {
    expect(passkeyPromptPreference(request(`${cookieName}=${value}`), "member-a", now).deferred).toBe(false);
  }
  expect(passkeyPromptPreference(request(`${cookie}; ${cookie}`), "member-a", now).deferred).toBe(false);
  expect(passkeyPromptPreference(request("", true), "member-a", now).cookieName).toBe(`__Host-${cookieName}`);
});

it.each([["/", homeHandle], ["/settings", settingsHandle]] as const)("includes the notice before the member header in %s server HTML and respects the deferred cookie", async (path, handle) => {
  const request = h.request(path, { as: "polish" });
  const data = await memberLoader(h.args(request));
  if (data.reader) throw new Error("Expected a member");
  const render = (loaderData: typeof data) => renderInRouter(() => createElement(MemberLayout, { loaderData, params: {}, matches: [] } as never), path, handle);
  const html = await render(data);
  expect(html.indexOf(messageMarkup(m.passkey_prompt()))).toBeGreaterThan(-1);
  expect(html.indexOf(messageMarkup(m.passkey_prompt()))).toBeLessThan(html.indexOf("<header"));
  expect(await render({ ...data, hasPasskey: true })).not.toContain(messageMarkup(m.passkey_prompt()));
  request.headers.set("cookie", `${request.headers.get("cookie")}; ${data.passkeyPrompt.cookieName}=${Date.now() + PASSKEY_PROMPT_MAX_AGE * 1000}`);
  const deferred = await memberLoader(h.args(request));
  if (deferred.reader) throw new Error("Expected a member");
  expect(await render(deferred)).not.toContain(messageMarkup(m.passkey_prompt()));
});
