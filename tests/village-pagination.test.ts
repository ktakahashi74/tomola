import { createElement } from "react";
import { expect, it, vi } from "vitest";
import Village from "~/routes/village";
import { renderInRouter } from "./helpers/render-in-router";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

it("village topic pagination drops management state while retaining reading and order choices", async () => {
  const html = await renderInRouter(() => createElement(Village, { loaderData: {
    village: { slug: "example", name: "Example", description: "", language: null, kind: "open" },
    membership: null, topics: [], order: "activity", page: 2, hasNext: true, langParam: "ja",
    reader: true, ended: false, operator: false, incoming: [], management: { canReadRoster: false },
    readingLanguage: { current: "ja", usual: "en", enabled: ["ja", "en"] },
  } } as never), "/v/example?manage=1&order=activity&lang=ja&asks=1&page=2&membersPage=3&invitesPage=4");
  const links = [...html.matchAll(/<a\b[^>]*rel="(?:prev|next)"[^>]*>/g)]
    .map(match => new URL(match[0].match(/href="([^"]+)"/)![1].replaceAll("&amp;", "&"), "http://localhost"));
  expect(links).toHaveLength(2);
  for (const link of links) {
    for (const key of ["manage", "membersPage", "invitesPage"]) expect(link.searchParams.has(key)).toBe(false);
    expect(link.searchParams.get("order")).toBe("activity");
    expect(link.searchParams.get("lang")).toBe("ja");
    expect(link.searchParams.get("asks")).toBe("1");
  }
  expect(links.map(link => link.searchParams.get("page"))).toEqual([null, "3"]);
});
