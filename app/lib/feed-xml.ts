// RSS 2.0, written by hand: a feed is a few dozen lines of XML, so no library is used. Free of server code, so tests can check it directly.

export type FeedItem = {
  title: string;
  link: string;
  pubDate: Date;
  // Plain text (never HTML).
  description: string;
  creator: string;
  category?: string;
};
export type Feed = {
  title: string;
  link: string;
  description: string;
  // The language of the titles and descriptions, when the feed was asked for one.
  language?: string;
  // The address of the feed itself.
  self: string;
  items: readonly FeedItem[];
};

// XML 1.0 allows tab, line feed, carriage return and the characters from U+0020 except the surrogates, U+FFFE and U+FFFF. Everything else (other controls, lone surrogates) is dropped,
// because one such character makes the whole document unreadable to a feed reader.
const NOT_XML_CHAR = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function xmlText(text: string): string {
  return text.replace(NOT_XML_CHAR, "").replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

const tag = (name: string, value: string, attributes = ""): string => `<${name}${attributes}>${xmlText(value)}</${name}>`;

export function rssXml(feed: Feed): string {
  const newest = feed.items.reduce<Date | null>((latest, item) => (latest === null || item.pubDate > latest ? item.pubDate : latest), null);
  const items = feed.items.map(item => [
    "<item>",
    tag("title", item.title),
    tag("link", item.link),
    tag("guid", item.link, ' isPermaLink="true"'),
    tag("pubDate", item.pubDate.toUTCString()),
    tag("description", item.description),
    tag("dc:creator", item.creator),
    ...(item.category ? [tag("category", item.category)] : []),
    "</item>",
  ].join("")).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    tag("title", feed.title),
    tag("link", feed.link),
    tag("description", feed.description),
    ...(feed.language ? [tag("language", feed.language)] : []),
    ...(newest ? [tag("lastBuildDate", newest.toUTCString())] : []),
    `<atom:link href="${xmlText(feed.self)}" rel="self" type="application/rss+xml"/>`,
    ...(items ? [items] : []),
    "</channel>",
    "</rss>",
    "",
  ].join("\n");
}
