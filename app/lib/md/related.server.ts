import { publicTopicPlace } from "~/lib/visibility.server";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import type { Lang } from "~/lib/languages";
import { listRelatedDiscussions } from "~/lib/related-discussions.server";
import { joinBlocks, mdBlock } from "~/lib/md/frontmatter.server";
import { mdUrl, siteUrl, twinPreamble } from "~/lib/md/urls.server";
import en from "../../../messages/en.json";

type Options = { lang: Lang | null; linkLang?: Lang | "all" | null; readLangs?: readonly Lang[]; k: string | null };
const escape = (value: string) => value.replace(/[\\`*_{}\[\]()<>#|]/g, "\\$&").replace(/[\r\n]/g, " ");

export async function relatedMarkdownBlock(db: Db, id: number, opts: Options & { inline?: boolean; page?: number }) {
  const result = await listRelatedDiscussions(db, id, { readLangs: opts.readLangs ?? [], displayLang: opts.lang ?? "en", lang: opts.lang, inline: opts.inline, page: opts.page, typesetTitles: false });
  if (opts.inline && !result.rows.length) return { block: null, ...result };
  const lines = result.rows.map(row => {
    const href = row.outgoing?.targetHref ?? row.incoming!.sourceHref;
    const directions = (["outgoing", "incoming"] as const).flatMap(kind => row[kind] ? [
      `  - ${kind === "outgoing" ? en.related_outgoing : en.related_incoming}: [${en.related_source}](${siteUrl(row[kind]!.sourceHref)})`,
    ] : []);
    return [`- [${escape(row.title.text)}](${siteUrl(href)})`, ...directions].join("\n");
  });
  if (opts.inline && result.omitted) lines.push(`[${en.related_all}](${mdUrl(`/t/${id}/related.md`, { ...opts, lang: opts.linkLang ?? opts.lang })})`);
  const block = mdBlock({ type: "related", thread: `p-${id}`, content_trust: "untrusted_user_content" },
    `## ${en.related_title}\n\n${opts.inline ? `${en.related_help}\n\n` : ""}${lines.join("\n\n")}`);
  return { block, ...result };
}

export async function buildRelatedMarkdown(db: Db, id: number, opts: Options & { page: number }) {
  const [topic] = await db.select({ id: entries.id }).from(entries).where(and(eq(entries.id, id), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace()));
  if (!topic) return null;
  const result = await relatedMarkdownBlock(db, id, opts);
  if (opts.page > result.pageCount) return null;
  const next = result.hasNext ? mdUrl(`/t/${id}/related.md`, { ...opts, lang: opts.linkLang ?? opts.lang, page: opts.page + 1 }) : null;
  return joinBlocks([
    mdBlock({ type: "index", thread: `p-${id}`, page: opts.page, page_count: result.pageCount, next, content_trust: "untrusted_user_content" }, null, { preamble: twinPreamble() }),
    result.block!,
  ]);
}
