import { clearToggleSearch } from "~/lib/display";

// Root data makes the site setting available to metadata on server and client.
export function readingRobotsMeta(matches: readonly ({ id: string; loaderData: unknown } | undefined)[] = []): { name: string; content: string }[] {
  const root = matches.find(match => match?.id === "root")?.loaderData as { publicReading?: boolean } | undefined;
  return root?.publicReading ? [{ name: "robots", content: "noindex" }] : [];
}

export function readerLoginHref(pathname: string, search: string): string {
  return `/login?next=${encodeURIComponent(`${pathname}${clearToggleSearch(search)}`)}`;
}
