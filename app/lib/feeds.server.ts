import { loadDisplayNames, selectDisplayName } from "./display-names.server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, villages } from "~/lib/db/schema";
import { authorLabel } from "~/lib/deleted-member";
import { listTopics, type TopicScope } from "~/lib/entries.server";
import { loadPickedTranslations } from "~/lib/entry-display.server";
import type { Feed, FeedItem } from "~/lib/feed-xml";
import { headlineFromBody } from "~/lib/headline.server";
import { siteUrl, threadCanonical } from "~/lib/md/urls.server";
import { markdownToPlainText } from "~/lib/plain-text.server";
import { previewText } from "~/lib/share-text";
import { villageName } from "~/lib/village-name";
import { villageDescription } from "~/lib/village-description";
import { localizeVillages } from "~/lib/village-translations.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import type { Village } from "~/lib/villages.server";
import { defaultLangOf, type Lang } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";
import { enabledLangs } from "~/lib/enabled-langs.server";

// RSS feeds of topics: the whole site and one village. Only what a reader who has not logged in may read, in the order of the home page's "new posts" (listTopics with no
// viewer: the same public conditions as every list). Replies are not in a feed. An item carries the title and the beginning of the body, never the whole body.

export const FEED_ITEMS = 30;

// The language of the text the site writes into a feed (the channel's description, the name of a language village, the words for a post with no text) when no ?lang= was asked: the
// site's default language, the same for every reader. It must not follow the language of the request, which is not the reader's choice for a feed.
const feedLocale = (): Lang => defaultLangOf(enabledLangs());

export type FeedScope =
  | { kind: "all" }
  | { kind: "village"; village: Village };

const topicScope = (scope: FeedScope): TopicScope =>
  scope.kind === "village" ? { kind: "village", villageId: scope.village.id } : { kind: "all" };

// `lang`: the language the titles and descriptions are asked in (the translation of each item, the original when there is none yet); null: the originals.
export async function loadFeedItems(db: Db, scope: FeedScope, lang: Lang | null): Promise<FeedItem[]> {
  const { topics } = await listTopics(db, topicScope(scope), { page: 1, limit: FEED_ITEMS, order: "created" });
  if (topics.length === 0) return [];
  const rows = await db.select({ id: entries.id, body: entries.body, villageId: entries.villageId }).from(entries).where(inArray(entries.id, topics.map(topic => topic.id)));
  const byId = new Map(rows.map(row => [row.id, row]));
  const titled = new Set(topics.filter(topic => topic.title !== null).map(topic => topic.id));
  const picked = lang ? await loadPickedTranslations(db, topics.map(topic => ({ id: topic.id, kind: "topic" as const, lang: topic.lang, sourceHash: topic.sourceHash })), lang, entry => titled.has(entry.id) ? ["title", "body"] : ["body"]) : new Map();
  const categories = scope.kind === "village" || !villagesEnabled() ? new Map<string, string>() : await villageCategories(db, [...new Set(rows.flatMap(row => row.villageId ? [row.villageId] : []))], lang);
  const locale = lang ?? feedLocale();
  const names = await loadDisplayNames(db, topics.map(topic => topic.authorHandle));
  return Promise.all(topics.map(async (topic): Promise<FeedItem> => {
    const row = byId.get(topic.id)!;
    const translation = picked.get(topic.id);
    const bodyText: string = translation?.body?.text ?? row.body;
    const bodyLang = translation?.body ? lang! : topic.lang;
    const title = topic.title !== null ? (translation?.title?.text ?? topic.title) : (await headlineFromBody(bodyText)) || m.headline_empty({}, { locale });
    return {
      title,
      link: `${threadCanonical(topic.id)}${lang ? `?lang=${lang}` : ""}`,
      pubDate: topic.createdAt,
      description: previewText(await markdownToPlainText(bodyText), bodyLang),
      creator: selectDisplayName(names.get(topic.authorHandle), locale) ?? authorLabel(topic.authorHandle),
      ...(row.villageId && categories.get(row.villageId) ? { category: categories.get(row.villageId) } : {}),
    };
  }));
}

// The name of each village the topics are in (as in the village chip of a list: villages that a member made, not the language villages), in the asked language when a translation exists.
async function villageCategories(db: Db, ids: readonly string[], lang: Lang | null): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const found = await db.select({ id: villages.id, slug: villages.slug, name: villages.name, language: villages.language }).from(villages).where(and(inArray(villages.id, [...ids]), isNull(villages.language)));
  const localized = await localizeVillages(db, found, lang ? { displayLang: lang, readLangs: [] } : null);
  return new Map(localized.map(village => [village.id, villageName(village, lang ?? feedLocale())]));
}

export async function buildFeed(db: Db, scope: FeedScope, lang: Lang | null, selfPath: string): Promise<Feed> {
  const items = await loadFeedItems(db, scope, lang);
  const locale = lang ?? feedLocale();
  const query = lang ? `?lang=${lang}` : "";
  const channel =
    scope.kind === "village"
      ? await (async () => {
          const [village] = await localizeVillages(db, [{ slug: scope.village.slug, name: scope.village.name, description: scope.village.description, language: scope.village.language }], lang ? { displayLang: lang, readLangs: [] } : null);
          return { title: villageName(village, locale), link: siteUrl(`/v/${scope.village.slug}${query}`), description: villageDescription(village, locale) || villageName(village, locale) };
        })()
      : { title: m.site_name(), link: siteUrl(`/${query}`), description: m.home_intro_guest({}, { locale }) };
  return { ...channel, ...(lang ? { language: lang } : {}), self: siteUrl(`${selfPath}${query}`), items };
}
