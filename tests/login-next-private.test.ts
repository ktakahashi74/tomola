import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderInRouter } from "./helpers/render-in-router";
import { messageMarkup } from "./helpers/message-markup";
import { m } from "~/paraglide/messages.js";
import { eq } from "drizzle-orm";
import { createAppAuth } from "~/lib/auth/auth.server";
import { settleMagicLinkMail } from "~/lib/auth/magic-link.server";
import { hashMagicLinkToken } from "~/lib/auth/plugins";
import { verification } from "~/lib/db/schema";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { cleanupExpiredLimits } from "~/lib/rate-limit.server";
import { formatErrorLog } from "~/lib/http/error-log.server";
import { action as login } from "~/routes/login";
import { action as confirm, loader as confirmPage } from "~/routes/auth-confirm";
import { addMember } from "./helpers/db";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
let n = 0;
const box = createMemoryMailbox();
const nextId = (token: string) => `magic-link-next:${hashMagicLinkToken(token)}`;
beforeAll(async () => {
  h = await setupRouteHarness();
  (globalThis as { __tomolaAuth?: Promise<unknown> }).__tomolaAuth = Promise.resolve(createAppAuth(h.db, {
    baseURL: BASE, secret: "test-secret-0123456789abcdef0123456789abcdef",
    mailer: () => createMailer(box.transport, "x@example.org"),
  }));
});
afterAll(() => h.restore());

it("explains member-page destinations only on the matching login screen", async () => {
  const route = await import("~/routes/login");
  for (const next of ["/u/aiko", "/", "/t/42"]) {
    const path = `/login?next=${encodeURIComponent(next)}`;
    const loaderData = await route.loader(h.args(h.request(path)));
    const html = await renderInRouter(() => createElement(route.default, { loaderData } as never), path);
    expect(html.includes(messageMarkup(m.login_members_only()))).toBe(next.startsWith("/u/"));
    expect(html).toMatch(/autocomplete="username webauthn"/i);
    expect(html).toContain(messageMarkup(m.login_invitation_short()));
  }
});
async function issue(next: string) {
  const name = `private${++n}`;
  await addMember(h.db, name, name, { email: `${name}@example.com` });
  const sent = await login(h.args(h.request("/login", { form: { email: `${name}@example.com`, next } })));
  await settleMagicLinkMail();
  const cookie = (sent as { init: { headers: Headers } }).init.headers.getSetCookie()[0].split(";")[0];
  const mail = box.sent.at(-1)!;
  const link = mail.text.match(/https?:\/\/\S+/)![0];
  const token = new URL(link).searchParams.get("token")!;
  return { cookie, mail, link, token };
}
const submit = (token: string, cookie: string, next = "/tampered") => confirm(h.args(h.request("/auth/confirm", { headers: { cookie }, form: { token, next } })));

it.each(["/search?q=private-search", `/t/new?${new URLSearchParams({ url: "https://private.example/a", title: "Secret title", text: "Secret quotation" })}`])("stores %s beside the token, excludes it from mail and GET, then consumes it after same-browser confirmation", async next => {
  const { mail, link, token, cookie } = await issue(next);
  const contents = `${mail.text}\n${mail.html}`;
  expect(new URL(link).searchParams.has("next")).toBe(false);
  for (const value of ["next=", "private-search", "private.example", "Secret title", "Secret+title", "Secret quotation"]) expect(contents).not.toContain(value);
  const [stored] = await h.db.select().from(verification).where(eq(verification.identifier, nextId(token)));
  const [credential] = await h.db.select().from(verification).where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(token)}`));
  expect(stored.value).toBe(next);
  expect(stored.expiresAt).toEqual(credential.expiresAt);
  expect(JSON.stringify(await confirmPage(h.args(new Request(`${link}&next=%2Ftampered`))))).not.toContain(next);
  const response = await submit(token, cookie) as Response;
  expect(response.headers.get("location")).toBe(next);
  expect(await h.db.select().from(verification).where(eq(verification.identifier, nextId(token)))).toEqual([]);
});

it("does not reveal or use the destination from another browser, and leaves the right browser able to consume it", async () => {
  const next = "/search?q=private-browser";
  const { token, cookie, link } = await issue(next);
  expect((await h.outcome(() => submit(token, ""))).status).toBe(400);
  expect(JSON.stringify(await confirmPage(h.args(new Request(link))))).not.toContain(next);
  expect((await submit(token, cookie) as Response).headers.get("location")).toBe(next);
});

it("does not use expired token destinations; existing verification sweeping removes them", async () => {
  const { token, cookie } = await issue("/search?q=expired-private");
  await h.db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(token)}`));
  await h.db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verification.identifier, nextId(token)));
  expect((await h.outcome(() => submit(token, cookie))).status).toBe(400);
  await cleanupExpiredLimits(h.db);
  expect(await h.db.select().from(verification).where(eq(verification.identifier, nextId(token)))).toEqual([]);
});

it("accepts a fully encoded maximum share and drops overlong destinations without failing login", async () => {
  const url = `https://example.org/${"😀".repeat(1980)}`;
  const next = `/t/new?${new URLSearchParams({ url, title: "😀".repeat(300), text: "😀".repeat(1000) })}`;
  expect(next.length).toBeGreaterThan(8000);
  const good = await issue(next);
  expect((await submit(good.token, good.cookie) as Response).headers.get("location")).toBe(next);
  const long = await issue(`/search?q=${"a".repeat(40_000)}`);
  expect(await h.db.select().from(verification).where(eq(verification.identifier, nextId(long.token)))).toEqual([]);
  expect((await submit(long.token, long.cookie) as Response).headers.get("location")).toBe("/");
});

it("validates site-local destinations on storage and again before using a stored value", async () => {
  for (const value of ["https://evil.example/", "//evil.example", "/a/..//evil.example"]) {
    const issued = await issue(value);
    expect(await h.db.select().from(verification).where(eq(verification.identifier, nextId(issued.token)))).toEqual([]);
    expect((await submit(issued.token, issued.cookie) as Response).headers.get("location")).toBe("/");
  }
  const issued = await issue("/t/42?page=2");
  await h.db.update(verification).set({ value: "https://evil.example/" }).where(eq(verification.identifier, nextId(issued.token)));
  expect((await submit(issued.token, issued.cookie) as Response).headers.get("location")).toBe("/");
});

it("removes refused destinations with unused credentials and never logs their contents", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await login(h.args(h.request("/login", { form: { email: "unknown-private@example.com", next: "/search?q=never-log-this" } })));
    await settleMagicLinkMail();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("never-log-this");
    expect((await h.db.select().from(verification)).some(row => row.value.includes("never-log-this"))).toBe(false);
  } finally { warn.mockRestore(); }
});

it("does not log the destination when its database write fails", async () => {
  const secret = "private-next-sql-failure";
  const insert = h.db.insert.bind(h.db);
  const spy = vi.spyOn(h.db, "insert").mockImplementation((table => {
    const builder = insert(table);
    if (Object.is(table, verification)) {
      const values = builder.values.bind(builder);
      builder.values = ((row: unknown) => {
        if (String((row as { identifier?: string }).identifier).startsWith("magic-link-next:")) throw new Error(`Failed query: params: /search?q=${secret}`);
        return values(row as never);
      }) as typeof builder.values;
    }
    return builder;
  }) as typeof h.db.insert);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let fault: unknown;
  try { await issue(`/search?q=${secret}`); } catch (error) { fault = error; }
  finally { spy.mockRestore(); }
  try {
    expect(fault).toBeInstanceOf(Error);
    expect(formatErrorLog(fault, h.request("/login", { form: { next: `/search?q=${secret}` } }))).not.toContain(secret);
    expect(log.mock.calls.flat().map(value => value instanceof Error ? value.stack : String(value)).join(" ")).not.toContain(secret);
  } finally { log.mockRestore(); }
});
