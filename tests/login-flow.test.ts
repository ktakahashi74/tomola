import { seedRateLimit } from "./helpers/fixtures";
import en from "../messages/en.json";
import { createElement } from "react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createAppAuth } from "~/lib/auth/auth.server";
import { settleMagicLinkMail } from "~/lib/auth/magic-link.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { createInvitation } from "~/lib/invitations.server";
import { rateLimits, verification } from "~/lib/db/schema";
import Login, { action, loader, meta } from "~/routes/login";
import { loader as inviteLoader, action as inviteAction } from "~/routes/invite";
import { action as logout } from "~/routes/logout";
import { action as confirm } from "~/routes/auth-confirm";
import { addMember } from "./helpers/db";
import { renderInRouter } from "./helpers/render-in-router";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
const box = createMemoryMailbox();
beforeAll(async () => {
  h = await setupRouteHarness();
  (globalThis as { __tomolaAuth?: Promise<unknown> }).__tomolaAuth = Promise.resolve(createAppAuth(h.db, {
    baseURL: BASE, secret: "test-secret-0123456789abcdef0123456789abcdef",
    mailer: () => createMailer(box.transport, "test@example.org"),
  }));
});
afterAll(() => h.restore());
const headersOf = (value: unknown) => value instanceof Response ? value.headers : new Headers((value as { init: { headers: Headers } }).init.headers);
const cookieOf = (value: unknown) => headersOf(value).getSetCookie().map(c => c.split(";")[0]).join("; ");
const send = (email: string, cookie = "", intent = "", accept = "", path = "/login?next=%2Fsettings") => action(h.args(h.request(path, { form: { email, intent, next: "/settings" }, headers: { cookie, accept } })));
const screen = async (cookie = "") => (await loader(h.args(h.request("/login?next=%2Fsettings", { headers: { cookie } }))));
const codePost = (cookie: string, code: string) => action(h.args(h.request("/login", { form: { intent: "login-code", code }, headers: { cookie } })));

it("uses both cookies for state B, shows the submitted address, and keeps code and browser secrets out of page data", async () => {
  await addMember(h.db, "flow-member", "flow_member", { email: "flow-member@example.com" });
  await createInvitation(h.db, { email: "flow-invited@example.com" });
  for (const email of ["flow-member@example.com", "flow-invited@example.com"]) {
    const response = await send(email);
    const cookie = cookieOf(response);
    expect(headersOf(response).getSetCookie().filter(c => /tomola.login-(code|email)=/.test(c))).toHaveLength(2);
    const state = await screen(cookie);
    expect(state).toMatchObject({ codePending: { email, invalid: false, limited: null }, next: "/settings" });
    const html = await renderInRouter(() => createElement(Login, { loaderData: state, actionData: undefined, params: {}, matches: [] } as never));
    expect(html).toContain("Enter the code");
    expect(html).toContain(email);
    expect(html).toContain("autofocus");
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain("Log in with a passkey");
    expect(meta({ loaderData: state } as never)).toEqual([{ title: "Enter the code" }]);
    await settleMagicLinkMail();
    if (email === "flow-member@example.com") {
      const mail = box.sent.at(-1)!;
      const code = mail.text.match(/\b(\d{3}) (\d{3})\b/)!;
      const token = new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
      const browserSecret = cookie.split("; ").find(c => c.startsWith("tomola.magic-link-browser="))!.split("=")[1];
      for (const secret of [`${code[1]}${code[2]}`, token, browserSecret]) expect(JSON.stringify(state) + html).not.toContain(secret);
      for (const secret of [`${code[1]}${code[2]}`, token]) expect(headersOf(response).getSetCookie().join("\n")).not.toContain(secret);
    }
    for (const name of ["tomola.login-code", "tomola.login-email"]) {
      const partial = cookie.split("; ").filter(c => !c.startsWith(`${name}=`)).join("; ");
      expect(await screen(partial)).toMatchObject({ codePending: null });
    }
    expect(await screen(`${cookie}; tomola.login-email=not-an-email`)).toMatchObject({ codePending: null });
  }
});

it("resends using the remembered address, resets failures, and restarts without consuming the emailed link", async () => {
  const email = "flow-resend@example.com";
  await createInvitation(h.db, { email });
  const first = await send(email);
  const cookie = cookieOf(first);
  await settleMagicLinkMail();
  const oldMail = box.sent.at(-1)!;
  const token = new URL(oldMail.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
  await codePost(cookie, "bad");
  expect(await screen(cookie)).toMatchObject({ codePending: { invalid: true } });
  const resend = await send("", cookie, "login-resend", "text/html");
  expect(resend).toBeInstanceOf(Response);
  expect((resend as Response).status).toBe(303);
  expect(headersOf(resend).get("location")).toBe("/login?next=%2Fsettings");
  const renewed = cookieOf(resend);
  expect(await screen(renewed)).toMatchObject({ codePending: { email, invalid: false, limited: null, resent: true } });
  await settleMagicLinkMail();
  expect(box.sent.at(-1)!.to).toBe(email);
  const before = await h.db.select().from(verification);
  const restart = await send("", renewed, "login-restart", "text/html");
  expect((restart as Response).status).toBe(303);
  expect(headersOf(restart).get("location")).toBe("/login?next=%2Fsettings");
  expect(headersOf(restart).getSetCookie()).toHaveLength(2);
  expect(headersOf(restart).getSetCookie().every(c => c.includes("Max-Age=0") && !c.includes("magic-link-browser"))).toBe(true);
  for (const [path, route, params] of [["/login.data?next=%2Fsettings&_routes=routes%2Flogin", action, {}], ["/invite/example.data?lang=ja", inviteAction, { token: "example" }]] as const) {
    const result = await route(h.args(h.request(path, { form: { intent: "login-restart" }, headers: { cookie: renewed } }), params)) as Response;
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe(path.replace(".data", "").replace("&_routes=routes%2Flogin", ""));
  }
  expect(await h.db.select().from(verification)).toEqual(before);
  const browserCookie = cookie.split("; ").find(c => c.startsWith("tomola.magic-link-browser="))!;
  const complete = await confirm(h.args(h.request("/auth/confirm", { form: { token }, headers: { cookie: browserCookie } }))) as Response;
  expect(complete.status).toBe(303);
  expect(complete.headers.getSetCookie().filter(c => /tomola.login-(code|email)=;/.test(c))).toHaveLength(2);
  expect(JSON.stringify(await screen(renewed))).not.toContain(token);
});

it("persists code and address limits without writing rows during loader reads, for a member and an invited recipient", async () => {
  await createInvitation(h.db, { email: "flow-limit-invited@example.com" });
  await addMember(h.db, "flow-limit-member", "flow_limit_member", { email: "flow-limit-member@example.com" });
  for (const email of ["flow-limit-member@example.com", "flow-limit-invited@example.com"]) {
    let cookie = cookieOf(await send(email));
    for (let round = 0; round < 4; round++) {
      const initialScreen = await screen(cookie);
      let rejection: unknown;
      for (let n = 0; n < 5; n++) rejection = await codePost(cookie, "bad");
      const expected = round === 3 ? "address" : "code";
      // Error actions do not automatically revalidate loaders in the browser.
      const html = await renderInRouter(() => createElement(Login, { loaderData: initialScreen, actionData: (rejection as { data: unknown }).data, params: {}, matches: [] } as never));
      expect(html).not.toContain('name="code"');
      expect(html).toContain(expected === "address" ? "codes cannot be used for a while" : "this code no longer works");
      const rows = await h.db.select().from(verification);
      const counters = await h.db.select().from(rateLimits);
      expect(await screen(cookie)).toMatchObject({ codePending: { limited: expected } });
      expect(await h.db.select().from(verification)).toEqual(rows);
      expect(await h.db.select().from(rateLimits)).toEqual(counters);
      cookie = cookieOf(await send("", cookie, "login-resend"));
      expect(await screen(cookie)).toMatchObject({ codePending: { limited: round === 3 ? "address" : null } });
    }
  }
});

it("does not use another address's pending state on an invitation", async () => {
  const invitation = await createInvitation(h.db, { email: "flow-invite@example.com" });
  await createInvitation(h.db, { email: "another@example.com" });
  const cookie = cookieOf(await send("another@example.com"));
  const inviteUrl = `/invite/${invitation.token}`;
  expect(await inviteLoader(h.args(h.request(inviteUrl, { headers: { cookie } }), { token: invitation.token }))).toMatchObject({ codePending: null });
  const sent = await inviteAction(h.args(h.request(inviteUrl, { form: {}, headers: { cookie } }), { token: invitation.token }));
  expect(await inviteLoader(h.args(h.request(inviteUrl, { headers: { cookie: cookieOf(sent) } }), { token: invitation.token }))).toMatchObject({ codePending: { email: "flow-invite@example.com" } });
});

it("rejects foreign restart and resend requests and counts them under the existing auth-page cap", async () => {
  for (const intent of ["login-restart", "login-resend"]) {
    expect((await h.outcome(() => action(h.args(h.request("/login", { form: { intent }, headers: { origin: "https://foreign.example" } }))))).status).toBe(403);
  }
  process.env.TRUSTED_PROXY_HOPS = "1";
  try {
    const { AUTH_PAGE_IP_LIMIT } = await import("~/lib/rate-limit.server");
    const request = () => h.request("/login", { form: { intent: "login-restart" }, headers: { "x-forwarded-for": "198.51.100.93" } });
    await seedRateLimit(h.db, "ip:auth-page:198.51.100.93", AUTH_PAGE_IP_LIMIT);
    expect((await h.outcome(() => action(h.args(request())))).status).toBe(429);
  } finally { delete process.env.TRUSTED_PROXY_HOPS; }
});

it("clears the pending pair on logout for HTTP and HTTPS, without clearing the browser binding", async () => {
  const globals = globalThis as { __tomolaAuth?: Promise<unknown> };
  const savedAuth = globals.__tomolaAuth;
  const savedURL = process.env.BETTER_AUTH_URL;
  try { for (const scheme of ["http", "https"]) {
    process.env.BETTER_AUTH_URL = `${scheme}://localhost:5173`;
    globals.__tomolaAuth = Promise.resolve(createAppAuth(h.db, { baseURL: process.env.BETTER_AUTH_URL, secret: "test-secret-0123456789abcdef0123456789abcdef", mailer: () => createMailer(box.transport, "test@example.org") }));
    const result = await logout(h.args(new Request(`${scheme}://localhost:5173/logout`, { method: "POST", headers: { origin: `${scheme}://localhost:5173` } }))) as Response;
    const prefix = scheme === "https" ? "__Host-" : "";
    const cookies = result.headers.getSetCookie().filter(c => c.startsWith(`${prefix}tomola.login-`));
    expect(cookies).toHaveLength(2);
    expect(cookies.every(c => c.includes("Max-Age=0") && c.includes("Path=/") && c.includes("HttpOnly") && c.includes("SameSite=Lax") && (scheme === "http" || c.includes("Secure")))).toBe(true);
    expect(result.headers.getSetCookie().some(c => c.includes("magic-link-browser"))).toBe(false);
  } } finally {
    globals.__tomolaAuth = savedAuth;
    if (savedURL === undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL = savedURL;
  }
});

it("sends a member who logs out to the posts where reading needs no login, and to the login screen where it does", async () => {
  const globals = globalThis as { __tomolaAuth?: Promise<unknown> };
  const savedAuth = globals.__tomolaAuth;
  const savedURL = process.env.BETTER_AUTH_URL;
  try {
    process.env.BETTER_AUTH_URL = "http://localhost:5173";
    globals.__tomolaAuth = Promise.resolve(createAppAuth(h.db, { baseURL: process.env.BETTER_AUTH_URL, secret: "test-secret-0123456789abcdef0123456789abcdef", mailer: () => createMailer(box.transport, "test@example.org") }));
    const out = async () => (await logout(h.args(new Request("http://localhost:5173/logout", { method: "POST", headers: { origin: "http://localhost:5173" } }))) as Response);
    vi.stubEnv("PUBLIC_READING", "");
    expect((await out()).headers.get("location")).toBe("/login");
    vi.stubEnv("PUBLIC_READING", "1");
    const open = await out();
    expect(open.headers.get("location")).toBe("/");
    expect(open.headers.getSetCookie().some(c => c.startsWith("tomola.logged-out=1"))).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    globals.__tomolaAuth = savedAuth;
    if (savedURL === undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL = savedURL;
  }
});

it("counts resends under the same per-address email limit and says 'later' once it is spent", async () => {
  const email = "flow-mail-cap@example.com";
  await createInvitation(h.db, { email });
  let response = await send(email);
  await settleMagicLinkMail();
  const started = box.sent.filter(mail => mail.to === email).length;
  // The first request and four resends fit the address's allowance; the next one is told "later", sends nothing and leaves the earlier code as it was.
  for (let n = 0; n < 4; n++) {
    response = await send("", cookieOf(response), "login-resend");
    expect(response).toMatchObject({ data: { status: "sent" } });
    expect(await screen(cookieOf(response))).toMatchObject({ codePending: { email, resent: true, invalid: false, limited: null } });
  }
  const cookie = cookieOf(response);
  const refused = await send("", cookie, "login-resend");
  expect(refused).toEqual({ status: "later", email });
  await settleMagicLinkMail();
  expect(box.sent.filter(mail => mail.to === email)).toHaveLength(started + 4);
  expect(await screen(cookie)).toMatchObject({ codePending: { email, invalid: false, limited: null } });
});

it("puts the 'later' notice right after the heading, drops the earlier 'sent again' line, and ties the address field to an 'unregistered' notice", async () => {
  const email = "flow-notice@example.com";
  await createInvitation(h.db, { email });
  const first = cookieOf(await send(email));
  const resent = cookieOf(await send("", first, "login-resend"));
  const state = await screen(resent);
  expect(state).toMatchObject({ codePending: { email, resent: true } });
  const render = (loaderData: unknown, actionData: unknown) => renderInRouter(() => createElement(Login, { loaderData, actionData, params: {}, matches: [] } as never));
  // Fragments come from the message table, so the test does not pin the wording; login_sent carries a placeholder, so only the text before it is used.
  const resentText = en.login_resent;
  const laterText = en.login_try_later;
  const sentText = en.login_sent.split("{")[0];
  const later = await render(state, { status: "later", email });
  expect(later).not.toContain(resentText);
  expect(later.indexOf(laterText)).toBeGreaterThan(later.indexOf("</h1>"));
  expect(later.indexOf(laterText)).toBeLessThan(later.indexOf(sentText));
  expect(await render(state, undefined)).toContain(resentText);
  const form = await render(await screen(), { status: "unregistered", email: "flow-nobody@example.com" });
  const described = /aria-describedby="([^"]+)"/.exec(form)?.[1];
  expect(described).toBeDefined();
  expect(form).toContain(`id="${described}"`);
  expect(form).toContain('value="flow-nobody@example.com"');
});
