import { ogLocale } from "~/lib/share-text";
import { shareLanguageHint } from "~/lib/share-language";

// The tags that make a link show a title, a description and an image when it is pasted into a chat or a social feed (Open Graph, plus the Twitter card names some previews still read).
// A route's `meta` builds them from its loader data; the origin of the site comes from the root loader, so the same address is made on the server and in the browser.

type Matches = readonly ({ id: string; loaderData: unknown } | undefined)[];
type MetaTag = { name: string; content: string } | { property: string; content: string };

export type ShareImage = { url: string; width: number; height: number; alt: string };
export type SharePreview = {
  type: "website" | "article";
  title: string;
  description?: string | null;
  // The language the title and the description are in.
  lang: string;
  image?: ShareImage | null;
  publishedTime?: string | null;
  author?: string | null;
};

type Site = { origin: string; langs: readonly string[] | null };

// The root loader's settings. A closed site (PUBLIC_READING empty) shows no preview: nothing in it is meant for a reader who has not logged in.
export function shareSite(matches: Matches = []): Site | null {
  const root = matches.find(match => match?.id === "root")?.loaderData as { publicReading?: boolean; siteOrigin?: string | null; enabledLangs?: readonly string[] } | undefined;
  return root?.publicReading && root.siteOrigin ? { origin: root.siteOrigin, langs: root.enabledLangs ?? null } : null;
}

// ?lang= as the page was asked for it, when it names a language this site has open (the feeds refuse any other); null otherwise.
function openLang(site: Site, location: { search: string }): string | null {
  return shareLanguageHint(location.search, site.langs, false)?.lang ?? null;
}

// Preserve the language clue so refetching og:url makes the same card. The preview-only hint belongs to topic pages alone.
export function shareUrl(site: Site, location: { pathname: string; search: string }): string {
  const hint = shareLanguageHint(location.search, site.langs, /^\/t\/[1-9]\d*$/.test(location.pathname));
  return `${site.origin}${location.pathname}${hint ? `?${hint.param}=${hint.lang}` : ""}`;
}

export function sharePreviewMeta(matches: Matches | undefined, location: { pathname: string; search: string }, preview: SharePreview | null): MetaTag[] {
  const site = shareSite(matches);
  if (!site || !preview) return [];
  const locale = ogLocale(preview.lang);
  const image = preview.image ?? { url: `${site.origin}/icons/share-default.png`, width: 512, height: 512, alt: "tomola" };
  return [
    { property: "og:site_name", content: "tomola" },
    { property: "og:type", content: preview.type },
    { property: "og:title", content: preview.title },
    ...(preview.description ? [{ property: "og:description", content: preview.description }, { name: "description", content: preview.description }] : []),
    { property: "og:url", content: shareUrl(site, location) },
    ...(locale ? [{ property: "og:locale", content: locale }] : []),
    ...(preview.author ? [{ property: "article:author", content: preview.author }] : []),
    ...(preview.publishedTime ? [{ property: "article:published_time", content: preview.publishedTime }] : []),
    { property: "og:image", content: image.url },
    { property: "og:image:width", content: String(image.width) },
    { property: "og:image:height", content: String(image.height) },
    ...(image.alt ? [{ property: "og:image:alt", content: image.alt }, { name: "twitter:image:alt", content: image.alt }] : []),
    { name: "twitter:card", content: preview.image ? "summary_large_image" : "summary" },
  ];
}

// <link rel="alternate"> to a feed (absolute address), carrying the page's ?lang= when it is an open language. Nothing on a closed site.
export function feedAlternate(matches: Matches | undefined, path: string, title: string, location: { search: string }): { tagName: "link"; rel: string; type: string; title: string; href: string }[] {
  const site = shareSite(matches);
  if (!site) return [];
  const lang = openLang(site, location);
  return [{ tagName: "link", rel: "alternate", type: "application/rss+xml", title, href: `${site.origin}${path}${lang ? `?lang=${lang}` : ""}` }];
}
