import { createTopic } from "~/lib/entries.server";
import { renderInRouter } from "./render-in-router";
import { setupRouteHarness, type RouteHarness } from "./route-harness";
import { setTestLocale } from "../stubs/paraglide-runtime";
import { routeElement } from "./route-fixtures";

export async function setupHomeWording() {
  const h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("john", { homeArea: "en", readLangs: ["en"] });
  const make = async (title: string | null, body: string, asksStance = false) => {
    const res = await createTopic(h.db, h.ids.hana, { lang: "ja", ...(title === null ? {} : { title }), body, asksStance });
    if (!res.ok) throw new Error("topic failed");
  };
  await make("朝の題", "朝のうちは涼しかった。");
  await make(null, `題のない長い本文。${"あ".repeat(900)}`);
  await make("賛否の命題", "条件です。", true);
  return h;
}

export async function drawHome(h: RouteHarness, locale: "en" | "ja", as = "hana", url = "/") {
  setTestLocale(locale);
  const { default: Home, loader } = await import("~/routes/home");
  const data = (await loader(h.args(h.request(url, { as }))));
  return renderInRouter(() => routeElement(Home, { loaderData: { ...data, aiOpen: { mdUrl: "http://x/home.md", mdPath: "/home.md" }, stanceMessage: null } }), url);
}

export const homeText = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
