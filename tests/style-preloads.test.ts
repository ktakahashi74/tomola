import type { EntryContext } from "react-router";
import { describe, expect, it } from "vitest";
import { addStylePreloads } from "~/lib/http/style-preloads.server";

function context(): EntryContext {
  return {
    manifest: { routes: { root: { css: ["/assets/base.css"] }, page: { css: ["/assets/base.css", "/assets/page.css"] }, unrelated: { css: ["/assets/unrelated.css"] } } },
    routeModules: { page: { links: () => [{ rel: "stylesheet", href: "/assets/linked.css" }, { rel: "modulepreload", href: "/assets/script.js" }, { rel: "preload", as: "fetch", href: "/reader.data?private=value" }] } },
    staticHandlerContext: { matches: [{ route: { id: "root" } }, { route: { id: "page" } }] },
  } as unknown as EntryContext;
}

describe("document style preloads", () => {
  it("uses matched manifest styles and stylesheet links, deduplicated, without scripts or unrelated routes", () => {
    const headers = new Headers({ "Content-Type": "text/html" });
    addStylePreloads(headers, 200, true, context());
    expect(headers.get("Link")).toBe(["base", "page", "linked"].map(name => `</assets/${name}.css>; rel=preload; as=style`).join(", "));
  });

  it("does not add hints to development, errors, redirects, or non-documents", () => {
    for (const [status, production, type] of [[200, false, "text/html"], [404, true, "text/html"], [500, true, "text/html"], [302, true, "text/html"], [200, true, "application/json"], [200, true, "text/markdown"], [200, true, "text/x-script"], [200, true, "text/css"]] as const) {
      const headers = new Headers({ "Content-Type": type });
      addStylePreloads(headers, status, production, context());
      expect(headers.has("Link")).toBe(false);
    }
  });

  it("allows only static CSS asset paths, excluding queries, external addresses and path traversal", () => {
    const unsafe = ["/assets/member.css?reader=private", "/assets/theme.css#private", "https://example.org/a.css", "//example.org/a.css", "/private.css", "/assets/a/../private.css", "/assets/./a.css", "/assets//a.css", "/assets/%2e%2e/a.css", "/assets/a.js", "/assets/a.css\r\nLink: secret"];
    const c = context();
    c.manifest.routes.root!.css!.push(...unsafe);
    c.routeModules.page!.links = () => unsafe.map(href => ({ rel: "stylesheet", href }));
    const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
    addStylePreloads(headers, 200, true, c);
    expect(headers.get("Link")).toBe("</assets/base.css>; rel=preload; as=style, </assets/page.css>; rel=preload; as=style");
  });

});
