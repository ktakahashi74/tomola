// A one-time greeting after signing up. The cookie holds only which greeting to show: "article" when the member came back to the post they were
// reading, "home" otherwise. The server clears it on the first page it is read for (see welcomeMiddleware), so the greeting shows once even without scripts.
import type { MiddlewareFunction } from "react-router";
import { m } from "~/paraglide/messages.js";

const NAME = "tomola.welcome";
export type WelcomeKind = "article" | "home";

export function welcomeCookie(request: Request, kind: WelcomeKind): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${NAME}=${kind}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secure}`;
}

export function readWelcome(request: Request): WelcomeKind | null {
  const found = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).find(value => value.startsWith(`${NAME}=`));
  const value = found?.slice(NAME.length + 1);
  return value === "article" || value === "home" ? value : null;
}

// Consume the greeting on the page response that carries it: the layout reads the cookie before this runs, and the reply tells the browser to drop it.
export const welcomeMiddleware: MiddlewareFunction = async ({ request }, next) => {
  const response = await next();
  if (request.method !== "GET" || !(response instanceof Response) || !response.ok || readWelcome(request) === null) return response;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", `${NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

export type WelcomeData = {
  kind: WelcomeKind;
  text: { label: string; joined: string; replyLink: string; hello: string; writeIntro: string; seeVillages: string; addPasskey: string; connectAi: string; close: string };
};

// What the greeting says, in the language of this request, or null when there is nothing to greet. Made on the server so the words stay out of the page's script.
export function welcomeFor(request: Request, handle: string): WelcomeData | null {
  const kind = readWelcome(request);
  if (!kind) return null;
  return { kind, text: {
    label: m.welcome_label(), joined: m.welcome_joined({ handle }), replyLink: m.welcome_reply_link(), hello: m.welcome_hello({ handle }),
    writeIntro: m.welcome_write_intro(), seeVillages: m.welcome_see_villages(), addPasskey: m.welcome_add_passkey(), connectAi: m.connect_keep_using_link(), close: m.welcome_close(),
  } };
}
