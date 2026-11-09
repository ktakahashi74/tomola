import { loadDisplayNames, displayNameFields } from "../display-names.server";
import { authorLabel } from "../deleted-member";
import { listVillages, villageBySlug } from "~/lib/villages.server";
import { localizeVillage, localizeVillages } from "~/lib/village-translations.server";
import type { Db } from "~/lib/db/client.server";
import { listTopics, type TopicOrder, type TopicSummary } from "~/lib/entries.server";
import { TOPICS_PER_PAGE } from "~/lib/pagination";
import { isStale } from "~/lib/display";
import { loadTopicLineTranslations, loadTitlelessBodies, type LineTranslation } from "~/lib/entry-display.server";
import { headlineFromBody } from "~/lib/headline.server";
import { joinBlocks, mdBlock, yamlList, type FmValue } from "~/lib/md/frontmatter.server";
import { TRANSLATION_STATUS } from "~/lib/md/translations.server";
import { accountsPointer, connectPointer } from "~/lib/api/connect.server";
import { isoSeconds, mdUrl, siteUrl, threadCanonical, twinPreamble } from "~/lib/md/urls.server";
import { isLang, type Lang } from "~/lib/languages";
import { villages as villagesTable } from "~/lib/db/schema";
import { inArray } from "drizzle-orm";
import type { Profile } from "~/lib/profiles.server";
import { loadReactions } from "~/lib/votes.server";

// List Markdown twins (/latest.md, /a/:lang.md, /home.md). Frontmatter type:index; body YAML topic array
// with id, title, original language, author, reply count, latest activity, Markdown/canonical URLs, and Insightful (「なるほど」) total/language count; end with paging block.
// ?lang= adds title_translation selected by display rules for each topic.
// A topic without a title (a short remark) has no title key; the one line at the start of its body is given as excerpt (the original) and excerpt_translation (when ?lang= is given).
// ?asks=1 filters to stance-asking topics. Question items include asks_stance:true.
// The stream home: ?long=1 keeps the topics with a title (long posts); ?order=created|activity|insightful gives the order (null: the list's own default: created for the home and a language list,
// activity for /latest.md), and the same order as the screen's, from the same listTopics call. An item has `created` (when it was posted) too. The index never carries a body: the body is read in
// the thread's Markdown twin (a topic without a title has `excerpt`, the beginning of its body).

// Followed posts with unread replies by default; ?all=1 includes every followed post. Latest activity first, and always the reader's own list.
export type ListSpec = { kind: "latest" } | { kind: "area"; lang: Lang } | { kind: "home" } | { kind: "following" } | { kind: "villages" } | { kind: "village"; slug: string; villageId: string };
export const allowsPublicListRead = (spec: ListSpec | null): boolean => spec?.kind !== "following";
export type ListMdOptions = { all?: boolean; page: number; lang: Lang | null; k: string | null; asks?: boolean; long?: boolean; order?: TopicOrder | null };

// The language a village's name and description are written in (lang) is always given once it is known; the machine translation of them beside the original, as a title has one,
// only when ?lang= asks for a language the village was not written in. `prefix` is put before the keys (the head of a village's own list says village_lang, village_name_translation, ...).
function villageTranslationFields(village: { name: string; description?: string; translation?: { from: Lang; originalName: string; originalDescription: string } }, sourceLang: string | null | undefined, lang: Lang | null, prefix = "") {
  const written = isLang(sourceLang) ? sourceLang : village.translation?.from;
  if (!lang || !village.translation) return written ? { [`${prefix}lang`]: written } : {};
  return {
    [`${prefix}lang`]: village.translation.from,
    [`${prefix}name_translation`]: village.name !== village.translation.originalName ? { lang, status: TRANSLATION_STATUS.primary, text: village.name } : undefined,
    [`${prefix}description_translation`]: village.description !== undefined && village.description !== village.translation.originalDescription ? { lang, status: TRANSLATION_STATUS.primary, text: village.description } : undefined,
  };
}

async function items(db: Db, topics: readonly TopicSummary[], opts: ListMdOptions): Promise<{ [key: string]: FmValue | undefined }[]> {
  const names = await loadDisplayNames(db, topics.map(t => t.authorHandle));
  const reactions = await loadReactions(db, topics.map((t) => ({ id: t.id })), null);
  // A topic without a title shows the beginning of its body instead (the original, and the translation when ?lang= asks for one).
  const bodies = await loadTitlelessBodies(db, topics);
  const picked = opts.lang
    ? await loadTopicLineTranslations(
        db,
        topics.map((t) => ({ id: t.id, kind: "topic" as const, lang: t.lang, sourceHash: t.sourceHash, title: t.title })),
        opts.lang,
      )
    : null;
  const translated = (row: LineTranslation | null, text: string): FmValue | undefined =>
    row ? { lang: opts.lang as Lang, status: TRANSLATION_STATUS[row.kind], engine: row.engine, model: row.model, fallback: row.fallback ? true : undefined, stale: isStale(row.flags), text } : undefined;
  return (await Promise.all(topics.map(async (t) => {
    const title = picked?.get(t.id)?.title ?? null;
    const bodyRow = picked?.get(t.id)?.body ?? null;
    return {
      id: `p-${t.id}`,
      title: t.title ?? undefined,
      excerpt: t.title === null ? (await headlineFromBody(bodies.get(t.id) ?? "")) : undefined,
      lang: t.lang,
      author: authorLabel(t.authorHandle),
      ...displayNameFields(names.get(t.authorHandle)),
      created: isoSeconds(t.createdAt),
      // Questions only: topics asking for stances.
      asks_stance: t.asksStance ? true : undefined,
      replies: t.replyCount,
      last_activity: isoSeconds(t.lastActivityAt),
      md: mdUrl(`/t/${t.id}.md`, { k: opts.k, lang: opts.lang }),
      canonical: threadCanonical(t.id),
      insightful: reactions.get(t.id)?.insightful.total ?? 0,
      insightful_langs: reactions.get(t.id)?.insightful.langs ?? 0,
      title_translation: translated(title, title?.text ?? ""),
      excerpt_translation: t.title === null ? translated(bodyRow, (await headlineFromBody(bodyRow?.text ?? ""))) : undefined,
    };
  })));
}

function section(list: { [key: string]: FmValue | undefined }[]): string {
  return list.length === 0 ? "No topics.\n" : yamlList(list);
}

export async function buildListMarkdown(db: Db, profile: Profile | null, spec: ListSpec, opts: ListMdOptions): Promise<string> {
  if (spec.kind === "villages") {
    const villages = await listVillages(db, profile?.userId);
    // As for titles, the original stays in name and description; with ?lang= a machine translation is added beside them.
    const translated = opts.lang ? await localizeVillages(db, villages, { displayLang: opts.lang, readLangs: [] }) : villages;
    const slugs = villages.flatMap(village => village.slug ? [village.slug] : []);
    const written = new Map(slugs.length ? (await db.select({ slug: villagesTable.slug, sourceLang: villagesTable.sourceLang }).from(villagesTable).where(inArray(villagesTable.slug, slugs))).map(row => [row.slug, row.sourceLang]) : []);
    return joinBlocks([
      mdBlock({ type: "index", title: "Villages", canonical: siteUrl("/villages"), content_trust: "untrusted_user_content" }, null, { preamble: twinPreamble() }),
      yamlList(translated.map((village, i) => ({ slug: village.slug, name: villages[i].name, description: villages[i].description, kind: village.kind, canonical: siteUrl(village.kind === "personal" ? `/u/${village.slug!.slice(1)}` : `/v/${village.slug}`), ...(village.kind === "personal" ? {} : { md: mdUrl(`/v/${village.slug}.md`, { k: opts.k, lang: opts.lang }) }), ...("members" in village ? { members: village.members, joined: village.joined } : {}), ...villageTranslationFields(village, written.get(village.slug), opts.lang) }))),
    ]);
  }
  if (spec.kind === "following" && !profile) throw new Error("The following list requires a member");
  const path = spec.kind === "village" ? `/v/${spec.slug}` : spec.kind === "latest" ? "/latest" : spec.kind === "area" ? `/a/${spec.lang}` : spec.kind === "following" ? "/following" : "/home";
  const asksOnly = opts.asks === true;
  // Questions only wins over long posts only (a question always has a title).
  const streamFilters = spec.kind !== "following";
  const titledOnly = streamFilters && opts.long === true && !asksOnly;
  // The order: the one asked for, or the list's default (the same as the screen's: /latest by the last activity, the others by new posts).
  const defaultOrder: TopicOrder = spec.kind === "latest" || spec.kind === "following" ? "activity" : "created";
  const order: TopicOrder = streamFilters ? opts.order ?? defaultOrder : defaultOrder;
  // The screen's address of the same list: only what differs from the default is written.
  const screenParams = new URLSearchParams();
  if (order !== defaultOrder) screenParams.set("order", order);
  if (asksOnly) screenParams.set("asks", "1");
  if (titledOnly) screenParams.set("long", "1");
  if (spec.kind === "following" && opts.all) screenParams.set("all", "1");
  const screenQuery = screenParams.toString() ? `?${screenParams.toString()}` : "";
  const canonical = siteUrl(`${spec.kind === "home" ? "/" : path}${screenQuery}`);
  // The query that the link to the next page carries, besides ?lang= and ?k= (mdUrl): the order if it was asked for, and the filters.
  const carry: Record<string, string> = {};
  if (opts.order && streamFilters) carry.order = opts.order;
  if (asksOnly) carry.asks = "1";
  if (titledOnly) carry.long = "1";
  if (spec.kind === "following" && opts.all) carry.all = "1";
  const scope = spec.kind === "village" ? ({ kind: "village", villageId: spec.villageId } as const) : spec.kind === "following" && profile ? ({ kind: "followed", userId: profile.userId, unreadOnly: !opts.all } as const) : spec.kind === "area" ? ({ kind: "langs", langs: [spec.lang] } as const) : ({ kind: "all" } as const);
  // The home and the language lists have the page size of the cards on the screen; /latest.md keeps its own.
  const result = await listTopics(db, scope, { page: opts.page, ...(spec.kind === "latest" ? {} : { limit: TOPICS_PER_PAGE }), order, asksOnly, titledOnly });
  const body = section(await items(db, result.topics, opts));
  const hasNext = result.hasNext;
  const orderPhrase = order === "insightful" ? "most Insightful marks first, newest first for equal counts" : order === "activity" ? "most recent activity first" : "newest first";
  const title =
    spec.kind === "village" ? spec.slug : spec.kind === "latest"
      ? "Latest topics"
      : spec.kind === "area"
        ? `Topics in ${spec.lang}`
        : spec.kind === "following"
          ? "Followed posts"
          : `Home: topics in every language, ${orderPhrase}`;
  const village = spec.kind === "village" ? await villageBySlug(db, spec.slug) : null;
  const translatedVillage = village && opts.lang ? await localizeVillage(db, { slug: village.slug, name: village.name, description: village.description, language: village.language }, { displayLang: opts.lang, readLangs: [] }) : null;
  const villageWritten = village?.sourceLang;
  const header = mdBlock(
    {
      type: "index",
      title,
      // The home is where an AI that was told only the site's address arrives. This site-written field (never taken from a post) says what to follow if the user asks to connect.
      // The home's note says what to follow to connect; the home, the latest topics and the language lists say where an account is explained (the lists a visitor can reach without one).
      ...(spec.kind === "home" ? { note: `${connectPointer()} ${accountsPointer()}` } : spec.kind === "latest" || spec.kind === "area" ? { note: accountsPointer() } : {}),
      lang: spec.kind === "area" ? spec.lang : undefined,
      order,
      ...(spec.kind === "following" ? { unread_only: !opts.all } : {}),
      ...(asksOnly ? { asks_only: true } : {}),
      ...(titledOnly ? { titled_only: true } : {}),
      canonical,
      content_trust: "untrusted_user_content",
      ...(village ? { village: village.slug, village_name: village.name, description: village.description, kind: village.kind, ended: !!village.endedAt, ...villageTranslationFields(translatedVillage ?? { name: village.name }, villageWritten, opts.lang, "village_") } : {}),
    },
    null,
    { preamble: twinPreamble() },
  );
  // Body YAML is generated here; all untrusted values such as titles are quoted YAML strings.
  const next = hasNext ? mdUrl(`${path}.md`, { k: opts.k, lang: opts.lang, page: opts.page + 1, extra: Object.keys(carry).length > 0 ? carry : undefined }) : null;
  const footer = mdBlock(
    { type: "index", page: opts.page, next, content_trust: "untrusted_user_content" },
    next ? `Next page: ${next}` : "End of list.",
  );
  return joinBlocks([header, `${body}`, footer]);
}
