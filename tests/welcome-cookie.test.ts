import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { WelcomeNotice } from "~/components/welcome-notice";
import { readWelcome, welcomeCookie, welcomeFor, welcomeMiddleware } from "~/lib/auth/welcome.server";
import { messageMarkup } from "./helpers/message-markup";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const request = (cookie: string, url = "http://localhost:5173/") => new Request(url, { headers: { cookie } });

it("remembers only which greeting to show, for an hour, out of reach of scripts", () => {
  const cookie = welcomeCookie(request(""), "article");
  expect(cookie).toContain("tomola.welcome=article");
  expect(cookie).toContain("Max-Age=3600");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).not.toContain("Secure");
  expect(welcomeCookie(request("", "https://tomola.example/"), "home")).toContain("Secure");
});

it("reads the greeting kind from the cookie header and ignores anything else", () => {
  expect(readWelcome(request("a=1; tomola.welcome=home"))).toBe("home");
  expect(readWelcome(request("tomola.welcome=article"))).toBe("article");
  expect(readWelcome(request("tomola.welcome=other"))).toBeNull();
  expect(readWelcome(request(""))).toBeNull();
});

it("drops the greeting on the first successful page response that carries it, and leaves other requests alone", async () => {
  const page = async (init: { method?: string; cookie?: string }, response = () => new Response("page")) =>
    await welcomeMiddleware({ request: new Request("https://tomola.example/", { method: init.method ?? "GET", headers: init.cookie ? { cookie: init.cookie } : {} }) } as never, (async () => response()) as never) as Response;
  const consumed = await page({ cookie: "tomola.welcome=home" });
  expect(consumed.headers.get("set-cookie")).toMatch(/tomola\.welcome=;.*Max-Age=0/);
  expect(consumed.headers.get("set-cookie")).toContain("Secure");
  expect(consumed.headers.get("cache-control")).toBe("no-store");
  expect((await page({})).headers.get("set-cookie")).toBeNull();
  expect((await page({ method: "POST", cookie: "tomola.welcome=home" })).headers.get("set-cookie")).toBeNull();
  expect((await page({ cookie: "tomola.welcome=home" }, () => new Response("gone", { status: 404 }))).headers.get("set-cookie")).toBeNull();
});

it("makes the greeting's words on the server, only when there is a greeting to show", () => {
  expect(welcomeFor(request(""), "mari")).toBeNull();
  const greeting = welcomeFor(request("tomola.welcome=article"), "mari");
  expect(greeting?.kind).toBe("article");
  expect(Object.keys(greeting!.text).sort()).toEqual(["addPasskey", "close", "connectAi", "hello", "joined", "label", "replyLink", "seeVillages", "writeIntro"]);
});

it("offers the connection guide in both post-signup greetings", () => {
  for (const kind of ["home", "article"]) {
    const welcome = welcomeFor(request(`tomola.welcome=${kind}`), "mari")!;
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(WelcomeNotice, { welcome, handle: "mari", passkeyOffer: false, villages: false })));
    expect(html).toContain('href="/connect"');
    expect(html).toContain("<aside");
    expect(html).toContain(messageMarkup(kind === "home" ? welcome.text.hello : welcome.text.joined));
  }
});
