import { expect, it } from "vitest";
import { matchRoutes, type RouteObject } from "react-router";
import routes from "../app/routes";
import { validVillageSlug } from "~/lib/villages";

it("reserves personal addresses and keeps village routes separate from personal style handles", () => {
  const convert = (entries: typeof routes): RouteObject[] => entries.map(entry => ({ path: entry.path, index: entry.index, id: entry.id ?? entry.file,
    ...(entry.children ? { children: convert(entry.children) } : {}) })) as RouteObject[];
  const configured = convert(routes);
  const leaf = (path: string) => matchRoutes(configured, path)?.at(-1)?.route.id;
  expect(validVillageSlug("personal")).toBe(false);
  for (const handle of ["alice", "chat", "icon", "feed.xml"]) expect(leaf(`/v/personal/${handle}`)).toBe("routes/personal-village-voice.tsx");
  for (const [suffix, id] of [["chat", "routes/village-chat.tsx"], ["icon", "routes/village-icon.ts"], ["feed.xml", "feed-village"], ["chat/search", "routes/village-chat-search.tsx"], ["chat/nushi", "routes/village-chat-nushi.ts"]]) {
    expect(leaf(`/v/garden/${suffix}`)).toBe(id);
  }
});
