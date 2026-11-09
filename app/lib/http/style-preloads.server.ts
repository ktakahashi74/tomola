import type { EntryContext } from "react-router";

function staticStylesheet(href: string): boolean {
  return /^\/assets\/[A-Za-z0-9_./-]+\.css$/.test(href)
    && href.slice("/assets/".length).split("/").every(part => part !== "" && part !== "." && part !== "..");
}

// The final HTML response supplies cacheable resource hints to an edge proxy.
// The origin sends no informational response and never hints scripts or data.
export function addStylePreloads(headers: Headers, status: number, production: boolean, context: EntryContext) {
  if (!production || status !== 200 || !/^text\/html(?:;|$)/i.test(headers.get("Content-Type") ?? "")) return;
  const styles = new Set<string>();
  for (const { route } of context.staticHandlerContext.matches) {
    for (const href of context.manifest.routes[route.id]?.css ?? []) styles.add(href);
    for (const link of context.routeModules[route.id]?.links?.() ?? []) {
      if ("rel" in link && link.rel === "stylesheet" && "href" in link && typeof link.href === "string") styles.add(link.href);
    }
  }
  const hints = [...styles].filter(staticStylesheet).map(href => `<${href}>; rel=preload; as=style`);
  if (hints.length) headers.append("Link", hints.join(", "));
}
