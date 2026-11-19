import { expect, it, vi } from "vitest";
import Village from "~/routes/village";
import { emptyVillageManagement } from "~/lib/village-management.server";
import { renderInRouter } from "./helpers/render-in-router";
import { routeElement } from "./helpers/route-fixtures";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

it("village topic pagination drops management state while retaining reading and order choices", async () => {
  const html = await renderInRouter(() => routeElement(Village, { loaderData: {
    village: { slug: "example", name: "Example", description: "", language: null, kind: "open", iconUrl: "", hasIcon: false },
    nushi: { setting: null, id: "example" }, nushiPage: false,
    list: { param: "list", legacyParam: "page", after: "old", start: "head", next: "next", count: 30, older: true, restored: false },
    membership: null, topics: [], order: "activity", page: 2, hasNext: true, langParam: "ja",
    writers: [], reader: true, ended: false, operator: false, incoming: [], management: emptyVillageManagement(),
    stanceMessage: null, source: { name: "Example", description: "", lang: null }, following: false, confirmingEnd: false, unfiltered: false,
    readingLanguage: { current: "ja", usual: "en", enabled: ["ja", "en"] },
  } }), "/v/example?manage=1&order=activity&lang=ja&asks=1&page=2&membersPage=3&invitesPage=4");
  const links = [...html.matchAll(/<a\b[^>]*rel="(?:prev|next)"[^>]*>/g)]
    .map(match => new URL(match[0].match(/href="([^"]+)"/)![1].replaceAll("&amp;", "&"), "http://localhost"));
  expect(links).toHaveLength(1);
  for (const link of links) {
    for (const key of ["manage", "membersPage", "invitesPage"]) expect(link.searchParams.has(key)).toBe(false);
    expect(link.searchParams.get("order")).toBe("activity");
    expect(link.searchParams.get("lang")).toBe("ja");
    expect(link.searchParams.get("asks")).toBe("1");
  }
  expect(links[0].searchParams.has("page")).toBe(false);
  expect(links[0].searchParams.get("list_after")).toBe("next");
  expect(html).toContain("Back to latest");
});
