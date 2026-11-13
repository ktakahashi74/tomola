import { m } from "~/paraglide/messages.js";
import { nushiCounts } from "./nushi.server";
import { loadDisplayNames, selectDisplayName } from "./display-names.server";
import type { Db } from "~/lib/db/client.server";
import { distributionViewerFor, readDistributions } from "~/lib/distribution.server";
import type { TopicSummary } from "~/lib/entries.server";
import { loadTitleDisplays, type TitleDisplay } from "~/lib/entry-display.server";
import type { Lang, SourceLang } from "~/lib/languages";
import type { Profile } from "~/lib/profiles.server";
import { loadLatestReplyLocations } from "~/lib/reply-locations.server";
import { toDistributionView, type DistributionView } from "~/lib/stance-ui";
import { loadOwnStances, type StanceState } from "~/lib/stances.server";
import { loadReactions, type InsightfulCount } from "~/lib/votes.server";
import { topicVillageNames } from "~/lib/villages.server";
import { localizeVillages } from "~/lib/village-translations.server";
import type { WithVillageTranslation } from "~/lib/village-translation-view";

// A list row (home, recent posts, or language area). Display titles using the same rules as posts: original if its language is readable, otherwise the translation into the display language,
// or the original with 「翻訳待ち」 if no translation exists.
export type TopicItem = {
  id: number;
  lang: SourceLang;
  langCode?: string | null;
  displayLang?: Lang;
  authorHandle: string;
  authorName?: string | null;
  replyCount: number;
  nushiCountLabel?: string;
  createdAt: string;
  lastActivityAt: string;
  latestReply: { id: number; page: number } | null;
  newReplies?: { count: number; href: string } | null;
  canChoose?: boolean;
  // Hidden topic (included in lists only when the viewer may see it).
  hidden: boolean;
  // Topic asking for stances (a question).
  asksStance: boolean;
  title: TitleDisplay;
  // For questions: the viewer's own stance and version, plus distribution totals and language count only, without per-area counts. Include distributions only after the viewer chooses a stance or with ?peek=<id>
  // (readDistributions excludes deleted and hidden questions, even from lists visible to the author, moderators, and operators). No other member's stance is included.
  stance?: StanceState;
  distribution?: DistributionView | null;
  // The Insightful count of the topic itself: the total and the number of languages (nothing per language). The viewer's own state is not part of a list item.
  insightful: InsightfulCount;
  village?: { slug: string; name: string } & WithVillageTranslation;
};

// viewer: member user and profile. peek: question id opened using 「先に結果を見る」 (?peek=<id>; readPeekParam).
// For questions only, load the viewer's own stances (loadOwnStances) and distributions (readDistributions). Do not read other members' stances.
const villageNameOf = (village: { slug: string; name: string }, localized: ReadonlyMap<string | null, { name: string } & WithVillageTranslation>) => {
  const found = localized.get(village.slug);
  return { slug: village.slug, name: found?.name ?? village.name, ...(found?.translation ? { translation: found.translation } : {}) };
};

export async function toTopicItems(
  db: Db,
  topics: readonly TopicSummary[],
  opts: { readLangs: readonly Lang[]; displayLang: Lang; viewer?: { userId: string; profile: Profile }; peek?: ReadonlySet<number>; showVillage?: boolean },
): Promise<TopicItem[]> {
  const questionIds = topics.filter((t) => t.asksStance).map((t) => t.id);
  const [titles, reactions, ownStances, latestReplies] = await Promise.all([
    loadTitleDisplays(db, topics, opts, true),
    // Lists show aggregate counts, without reading the viewer's own reactions.
    loadReactions(db, topics.map((t) => ({ id: t.id })), null),
    opts.viewer ? loadOwnStances(db, opts.viewer.userId, questionIds) : Promise.resolve(new Map<number, StanceState>()),
    loadLatestReplyLocations(db, topics.map(t => t.id)),
  ]);
  // Distributions only for questions where the viewer has chosen a stance or opted to see results first.
  const wanted = questionIds.filter((id) => ownStances.get(id)?.position != null || opts.peek?.has(id));
  const distributions = opts.viewer ? await readDistributions(db, wanted, distributionViewerFor(opts.viewer)) : new Map();
  const villageNames = opts.showVillage ? await topicVillageNames(db, topics.map(topic => topic.id)) : new Map();
  // The name of a village made in another language is read in the reader's (the original stays in the tooltip).
  const localized = new Map((await localizeVillages(db, [...villageNames.values()].map(village => ({ slug: village.slug, name: village.name, language: null })), { displayLang: opts.displayLang, readLangs: opts.readLangs })).map(village => [village.slug, village]));
  const names = await loadDisplayNames(db, topics.map(t => t.authorHandle));
  const nushi = await nushiCounts(db, topics.map(topic => topic.id));
  return topics.map((t) => ({
    id: t.id,
    lang: t.lang, langCode: t.langCode,
    displayLang: opts.displayLang,
    authorHandle: t.authorHandle,
    authorName: selectDisplayName(names.get(t.authorHandle)),
    replyCount: t.replyCount,
    ...(nushi.has(t.id) ? { nushiCountLabel: m.nushi_count({ count: nushi.get(t.id)! }) } : {}),
    createdAt: t.createdAt.toISOString(),
    lastActivityAt: t.lastActivityAt.toISOString(),
    latestReply: latestReplies.get(t.id) ?? null,
    canChoose: !!opts.viewer && !t.hidden && !(opts.viewer.profile.suspendedUntil && opts.viewer.profile.suspendedUntil > new Date()),
    hidden: t.hidden,
    asksStance: t.asksStance,
    // loadTitleDisplays answers for every topic it is given: the title, or the beginning of the body for a topic without a title.
    title: titles.get(t.id)!,
    ...(t.asksStance && opts.viewer
      ? { stance: ownStances.get(t.id) ?? { position: null, version: 0 }, distribution: distributions.has(t.id) ? toDistributionView(distributions.get(t.id)!) : null }
      : {}),
    insightful: reactions.get(t.id)?.insightful ?? { total: 0, langs: 0 },
    ...(villageNames.has(t.id) ? { village: villageNameOf(villageNames.get(t.id)!, localized) } : {}),
  }));
}
