import { selectDisplayName, displayNameFields } from "./display-names.server";
import { mdBlock } from "./md/frontmatter.server";
import { authorLabel } from "./deleted-member";
import { retainedAuthorColumn } from "./deleted-member.server";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, translations } from "~/lib/db/schema";
import { FLAG_STRUCTURE_MISMATCH } from "./llm/flags";
import { pickTranslation, isStale } from "~/lib/display";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { headlineFromBody } from "~/lib/headline.core.server";
import { isLang, LANGS, LANG_LABELS, type Lang } from "~/lib/languages";
import { renderMarkdownOrPlain, RENDER_VERSION } from "~/lib/markdown.core.server";
import { typesetText } from "~/lib/typeset-text";
import { readMediaBatch } from "~/lib/media-store.server";
import { mediaPath } from "~/lib/media";
import { resolveSavedMentionsFor, resolveTranslationMentionsFor } from "~/lib/mentions.server";
import { publicTopicPlace, rootTopic, rootTopicOn, visibleWithTopic } from "~/lib/visibility.server";
import { escapeHtml as h, EXPORT_CSS, offlineHtml, offlineMarkdown, referencedMedia, relativeFile, type ExportLinks } from "~/lib/site-export-format.core.server";
import { m } from "~/paraglide/messages.js";
import { hasUndeletedReply } from "~/lib/reply-placeholders.server";
import { localizeResponseBodies } from "./response-line.server";

const publicColumns = {
  id: entries.id, kind: entries.kind, threadId: entries.threadId, parentId: entries.parentId,
  lang: entries.lang, title: entries.title, body: entries.body, html: entries.html, htmlVersion: entries.htmlVersion,
  sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision,
  displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea,
  handle: retainedAuthorColumn(entries.authorId, profiles.handle, "handle"), createdAt: entries.createdAt, changedAt: entries.changedAt, asksStance: entries.asksStance,
};

async function readSnapshot(db: Db, langs: readonly Lang[], documents: readonly Document[]) {
  return db.transaction(async tx => {
    const posts = await tx.select(publicColumns).from(entries)
      .innerJoin(rootTopic, rootTopicOn()).leftJoin(profiles, eq(profiles.userId, entries.authorId))
      .where(and(visibleWithTopic(), eq(rootTopic.kind, "topic"))).orderBy(desc(entries.createdAt), desc(entries.id));
    // No hidden/deleted text, title, language, author or timestamp is read here.
    const placeholders = await tx.select({ id: entries.id, threadId: entries.threadId, parentId: entries.parentId,
      deleted: isNotNull(entries.deletedAt).mapWith(Boolean) })
      .from(entries).innerJoin(rootTopic, rootTopicOn())
      .where(and(eq(entries.kind, "reply"), eq(rootTopic.kind, "topic"), isNull(rootTopic.deletedAt), isNull(rootTopic.hiddenAt), publicTopicPlace(rootTopic),
        or(isNotNull(entries.deletedAt), isNotNull(entries.hiddenAt)),
        or(isNull(entries.deletedAt), hasUndeletedReply())))
      .orderBy(asc(entries.createdAt), asc(entries.id));
    const translated = await localizeResponseBodies(tx as Db, await tx.select({ id: translations.id, entryId: translations.entryId, field: translations.field,
      lang: translations.lang, kind: translations.kind, text: translations.text, html: translations.html,
      htmlVersion: translations.htmlVersion, sourceHash: translations.sourceHash, mentionRevision: translations.mentionRevision,
      flags: translations.flags, updatedAt: translations.updatedAt })
      .from(translations).innerJoin(entries, eq(entries.id, translations.entryId)).innerJoin(rootTopic, rootTopicOn())
      .where(and(visibleWithTopic(), eq(rootTopic.kind, "topic"))));
    // A separate order-only read keeps redacted rows out of publicColumns.
    const order = await tx.select({ id: entries.id }).from(entries).innerJoin(rootTopic, rootTopicOn())
      .where(and(eq(entries.kind, "reply"), eq(rootTopic.kind, "topic"), isNull(rootTopic.deletedAt), isNull(rootTopic.hiddenAt), publicTopicPlace(rootTopic)))
      .orderBy(asc(entries.createdAt), asc(entries.id));
    const sourceMentions = await resolveSavedMentionsFor(tx, posts.filter(post => !post.html || post.htmlVersion !== RENDER_VERSION));
    const translationMentions = await resolveTranslationMentionsFor(tx, translated.filter(row => row.field === "body" && (!row.html || row.htmlVersion !== RENDER_VERSION)));
    const imageIds = new Set<string>();
    const addImages = (text: string) => referencedMedia(text, process.env.BETTER_AUTH_URL).forEach(id => imageIds.add(id));
    for (const post of posts) for (const lang of langs) {
      const row = post.lang === lang ? null : pickTranslation(translated.filter(t => t.entryId === post.id && t.field === "body" && t.lang === lang), post.sourceHash, post.mentionRevision);
      addImages(row?.text ?? post.body);
    }
    documents.forEach(doc => addImages(doc.markdown));
    // Assets share the public-text snapshot; hidden posts and unused translations cannot add files.
    const images = await readMediaBatch(tx, [...imageIds]);
    return { posts, placeholders, translated, order, sourceMentions, translationMentions, images, exportedAt: new Date().toISOString() };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;
type Post = Snapshot["posts"][number];
type Translation = Snapshot["translated"][number];
type Document = { lang: Lang; name: "principles" | "why" | "name"; markdown: string };
const defaultContentDir = fileURLToPath(new URL("../content/", import.meta.url));
const require = createRequire(import.meta.url);
const defaultKatexDir = path.dirname(require.resolve("katex/dist/katex.min.css"));
const exportIdentity = { format: "tomola-public-site", version: 1 } as const;

function languages(selected: readonly Lang[] | undefined): Lang[] {
  const langs = selected ?? enabledLangs();
  if (langs.length === 0 || langs.some(lang => !isLang(lang))) throw new Error("Select at least one supported language");
  const enabled = enabledLangs();
  const requested = LANGS.filter(lang => langs.includes(lang) && enabled.includes(lang));
  if (requested.length === 0) throw new Error("Select at least one enabled language");
  return requested;
}

async function readDocuments(contentDir: string, langs: readonly Lang[]): Promise<Document[]> {
  const docs: Document[] = [];
  for (const lang of langs) for (const name of ["principles", "why", "name"] as const) {
    try { docs.push({ lang, name, markdown: await fs.readFile(path.join(contentDir, name, `${lang}.md`), "utf8") }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return docs;
}

function page(title: string, lang: Lang, file: string, body: string, nav: string): string {
  return `<!doctype html>\n<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"><title>${h(title)} · tomola</title><link rel="stylesheet" href="${relativeFile(file, "assets/site.css")}"><link rel="stylesheet" href="${relativeFile(file, "assets/katex.min.css")}"></head><body><nav>${nav}</nav><main>${body}</main></body></html>\n`;
}

function choose(snapshot: Snapshot, post: Post, rows: readonly Translation[], field: "title" | "body", lang: Lang, render = false) {
  const fromBody = field === "title" && post.title === null;
  const selectedField = fromBody ? "body" : field;
  const source = selectedField === "title" ? post.title! : post.body;
  const translation = post.lang === lang ? null : pickTranslation(rows.filter(t => t.field === selectedField && t.lang === lang), post.sourceHash, post.mentionRevision);
  const stale = translation?.kind === "human" && (isStale(translation.flags) || (translation.mentionRevision !== null && translation.mentionRevision !== post.mentionRevision));
  const status = translation ? (stale ? "stale" : translation.kind === "human" ? "human" : "machine") : post.lang === lang ? "source" : "missing";
  const chosenText = translation?.text ?? source;
  const text = fromBody ? headlineFromBody(chosenText) : chosenText;
  const html = render && field === "body"
    ? (translation ? (translation.html && translation.htmlVersion === RENDER_VERSION ? translation.html : renderMarkdownOrPlain(text, { lang, idPrefix: `p-${post.id}-${lang}-`, mentions: snapshot.translationMentions.get(translation.id), translation: translation.kind === "primary" }))
      : (post.html && post.htmlVersion === RENDER_VERSION ? post.html : renderMarkdownOrPlain(text, { lang: post.lang, idPrefix: `p-${post.id}-`, mentions: snapshot.sourceMentions.get(post.id) })))
    : "";
  const displayText = field === "title" && !fromBody && translation?.kind === "primary" ? typesetText(text, lang) : text;
  return { text, displayText, html, status, structureMismatch: translation?.flags.includes(FLAG_STRUCTURE_MISMATCH) ?? false, lang: translation ? lang : post.lang, updatedAt: translation?.updatedAt ?? post.changedAt };
}

function statusLabel(status: string, lang: Lang): string {
  const o = { locale: lang };
  switch (status) {
    case "human": return m.site_export_human({}, o);
    case "machine": return m.site_export_machine({}, o);
    case "stale": return m.site_export_stale({}, o);
    case "missing": return m.site_export_missing({}, o);
    default: return m.site_export_source({}, o);
  }
}

export type SiteExportOptions = { outDir: string; langs?: readonly Lang[]; contentDir?: string; katexDir?: string };

// Filesystem changes are restricted to a sibling staging directory until every
// read, render and asset copy succeeds. A failed replacement restores the old tree.
export async function exportSite(db: Db, options: SiteExportOptions) {
  const out = path.resolve(options.outDir);
  if (out === path.parse(out).root) throw new Error("The output must be a dedicated directory");
  try {
    const stat = await fs.lstat(out);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The output must be a directory, not a file or symbolic link");
    if ((await fs.readdir(out)).length > 0) {
      const manifest = await fs.readFile(path.join(out, "manifest.json"), "utf8")
        .then(text => JSON.parse(text) as { format?: unknown; version?: unknown } | null, () => null)
        .catch(() => null);
      if (manifest?.format !== exportIdentity.format || manifest.version !== exportIdentity.version) {
        throw new Error("A nonempty output directory must have this export's manifest marker");
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const requestedLangs = languages(options.langs);
  // Closed source languages stay readable on these pages through the normal
  // original-text fallback. Closed-language translations never get a page.
  const langs = requestedLangs;
  const documents = await readDocuments(options.contentDir ?? defaultContentDir, langs);
  const snapshot = await readSnapshot(db, langs, documents);
  const imageFiles = new Map(snapshot.images.map(image => [image.id, `assets${mediaPath(image.id, image.width, image.height)}`]));
  const documentKeys = new Set(documents.map(doc => `${doc.lang}/${doc.name}`));
  const posts = new Map(snapshot.posts.map(post => [post.id, post.threadId ?? post.id]));
  const byId = new Map(snapshot.posts.map(post => [post.id, post]));
  const placeholders = new Map(snapshot.placeholders.map(row => [row.id, row]));
  const repliesByThread = new Map<number, number[]>();
  for (const row of snapshot.order) {
    const thread = byId.get(row.id)?.threadId ?? placeholders.get(row.id)?.threadId;
    if (thread === null || thread === undefined) continue;
    const list = repliesByThread.get(thread) ?? [];
    list.push(row.id); repliesByThread.set(thread, list);
  }
  const translated = new Map<number, Translation[]>();
  for (const row of snapshot.translated) {
    const list = translated.get(row.entryId) ?? [];
    list.push(row); translated.set(row.entryId, list);
  }
  const linksFor = (file: string, lang: Lang, extension: "html" | "md"): ExportLinks => ({
    page: file, lang, extension, posts, documents: documentKeys, origin: process.env.BETTER_AUTH_URL || undefined, media: imageFiles,
  });
  const documentTitle = (doc: Document) => doc.name === "principles" ? m.footer_principles({}, { locale: doc.lang })
    : doc.name === "why" ? m.footer_why({}, { locale: doc.lang }) : doc.markdown.match(/^# (.+)$/m)?.[1].trim() ?? "tomola";
  const nav = (file: string, lang: Lang) => {
    const o = { locale: lang };
    const items = [`<a href="${relativeFile(file, `${lang}/index.html`)}">${h(m.site_export_index({}, o))}</a>`];
    for (const doc of documents.filter(doc => doc.lang === lang && doc.name !== "name")) {
      items.push(`<a href="${relativeFile(file, `${lang}/${doc.name}.html`)}">${h(documentTitle(doc))}</a>`);
    }
    items.push(`<a href="${relativeFile(file, "index.html")}">${h(m.site_export_languages({}, o))}</a>`);
    return items.join(" ");
  };
  await fs.mkdir(path.dirname(out), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(out), `.${path.basename(out)}.tmp-`));
  let files = 0, bytes = 0;
  const write = async (file: string, text: string | Uint8Array) => {
    await fs.mkdir(path.dirname(path.join(staging, file)), { recursive: true });
    await fs.writeFile(path.join(staging, file), text); files++; bytes += typeof text === "string" ? Buffer.byteLength(text) : text.byteLength;
  };
  try {
    await write("assets/site.css", EXPORT_CSS);
    for (const image of snapshot.images) if (image.bytes) await write(imageFiles.get(image.id)!, image.bytes);
    const katexDir = options.katexDir ?? defaultKatexDir;
    await write("assets/katex.min.css", await fs.readFile(path.join(katexDir, "katex.min.css"), "utf8"));
    await write("assets/KaTeX-LICENSE.txt", await fs.readFile(path.join(katexDir, "../LICENSE"), "utf8"));
    await fs.cp(path.join(katexDir, "fonts"), path.join(staging, "assets/fonts"), { recursive: true });
    for (const font of await fs.readdir(path.join(staging, "assets/fonts"))) {
      const stat = await fs.stat(path.join(staging, "assets/fonts", font)); files++; bytes += stat.size;
    }
    const topics = snapshot.posts.filter(post => post.kind === "topic");
    for (const lang of langs) {
      const o = { locale: lang };
      const index = `${lang}/index.html`;
      const items: string[] = [];
      for (const topic of topics) {
        const file = `${lang}/t/${topic.id}.html`, mdFile = `${lang}/t/${topic.id}.md`;
        const title = choose(snapshot, topic, translated.get(topic.id) ?? [], "title", lang);
        const heading = title.displayText || m.headline_empty({}, o);
        const markdownHeading = title.text || m.headline_empty({}, o);
        items.push(`<li><a href="t/${topic.id}.html">${h(heading)}</a> <span class="meta"><bdi>${h(selectDisplayName(topic, lang) ?? authorLabel(topic.handle))}</bdi> · ${h(topic.lang)} · ${topic.createdAt.toISOString().slice(0, 10)}</span></li>`);
        const html: string[] = [`<h1 lang="${title.lang}">${h(heading)}</h1>`], markdown: string[] = [`# ${markdownHeading.replace(/[\r\n]/g, " ").replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&")}`];
        const addPost = (post: Post) => {
          const body = choose(snapshot, post, translated.get(post.id) ?? [], "body", lang, true);
          const sourceLang = post.lang as Lang;
          const anchor = post.kind === "reply" ? `c-${post.id}` : `p-${post.id}`;
          const sourceTarget = `${sourceLang}/t/${post.threadId ?? post.id}`;
          const sourceAnchor = post.kind === "reply" ? `#${anchor}` : "";
          const sourceHtml = relativeFile(file, `${sourceTarget}.html`) + sourceAnchor;
          const sourceMd = relativeFile(mdFile, `${sourceTarget}.md`) + sourceAnchor;
          const parent = post.parentId ?? topic.id;
          const parentHtml = post.parentId === null ? `#p-${topic.id}` : `#c-${parent}`;
          const name = selectDisplayName(post, lang);
          const meta = `${name ? `<bdi>${h(name)}</bdi> ` : ""}<bdi>${h(authorLabel(post.handle))}</bdi> · ${h(post.lang)} · ${post.createdAt.toISOString()}`;
          const status = statusLabel(body.status, lang);
          html.push(`<article id="${anchor}"><p class="meta">${meta}${post.kind === "reply" ? ` · <a href="${parentHtml}">${h(m.site_export_reply_to({}, o))} #${parent}</a>` : ""}</p>`);
          if (post.asksStance) html.push(`<p class="status">${h(m.question_badge({}, o))}</p>`);
          const sourceLabel = `${m.site_export_source({}, o)} (${sourceLang})`;
          html.push(`<p class="status" data-status="${body.status}">${h(status)} · ${langs.includes(sourceLang) ? `<a href="${sourceHtml}" lang="${sourceLang}">${h(sourceLabel)}</a>` : h(sourceLabel)}</p>`);
          if (body.structureMismatch || title.structureMismatch) html.push(`<p class="status" role="note">${h(m.translation_structure_note({}, o))}</p>`);
          if (post.kind === "topic" && title.status !== body.status) html.push(`<p class="status" data-title-status="${title.status}">${h(m.site_export_title_status({ status: statusLabel(title.status, lang) }, o))}</p>`);
          html.push(`<div lang="${body.lang}">${offlineHtml(body.html, linksFor(file, lang, "html"))}</div></article>`);
          markdown.push(`<a id="${anchor}"></a>\n\n${post.kind === "reply" ? `## ${m.reply_title({}, o)} #${post.id}\n\n` : ""}${authorLabel(post.handle)} · ${post.lang} · ${post.createdAt.toISOString()}`);
          markdown.push(mdBlock({ type: "author", author: authorLabel(post.handle), ...displayNameFields(post) }, null));
          if (post.kind === "reply") markdown.push(`${m.site_export_reply_to({}, o)}: #${parent}`);
          if (post.asksStance) markdown.push(m.question_badge({}, o));
          markdown.push(`${status} · ${langs.includes(sourceLang) ? `[${sourceLabel}](${sourceMd})` : sourceLabel}`);
          if (body.structureMismatch || title.structureMismatch) markdown.push(m.translation_structure_note({}, o));
          if (post.kind === "topic" && title.status !== body.status) markdown.push(m.site_export_title_status({ status: statusLabel(title.status, lang) }, o));
          markdown.push(offlineMarkdown(body.text, linksFor(mdFile, lang, "md")));
        };
        addPost(topic);
        html.push(`<h2>${h(m.site_export_replies({}, o))}</h2>`);
        markdown.push(`## ${m.site_export_replies({}, o)}`);
        for (const id of repliesByThread.get(topic.id) ?? []) {
          const post = byId.get(id);
          if (post?.threadId === topic.id) addPost(post);
          const placeholder = placeholders.get(id);
          if (placeholder?.threadId !== topic.id) continue;
          const label = placeholder.deleted ? m.entry_deleted_placeholder({}, o) : m.entry_hidden_placeholder({}, o);
          const parent = placeholder.parentId ?? topic.id;
          html.push(`<article class="placeholder" id="c-${id}"><p>${h(label)} · #${id}</p><p><a href="#${placeholder.parentId === null ? "p" : "c"}-${parent}">${h(m.site_export_reply_to({}, o))} #${parent}</a></p></article>`);
          markdown.push(`<a id="c-${id}"></a>\n\n## ${m.reply_title({}, o)} #${id}\n\n${label}\n\n${m.site_export_reply_to({}, o)}: #${parent}`);
        }
        const alternate = langs.map(other => `<a hreflang="${other}" href="${relativeFile(file, `${other}/t/${topic.id}.html`)}">${h(LANG_LABELS[other])}</a>`).join(" ");
        html.push(`<p><a href="${topic.id}.md">Markdown</a></p><nav>${alternate}</nav>`);
        await write(file, page(heading, lang, file, html.join("\n"), nav(file, lang)));
        await write(mdFile, markdown.join("\n\n") + "\n");
      }
      await write(index, page(m.site_export_index({}, o), lang, index, `<h1>${h(m.site_export_index({}, o))}</h1><ul>${items.join("\n")}</ul>`, nav(index, lang)));
      for (const doc of documents.filter(doc => doc.lang === lang)) {
        const file = `${lang}/${doc.name}.html`, mdFile = `${lang}/${doc.name}.md`;
        const title = documentTitle(doc);
        const source = documentKeys.has(`ja/${doc.name}`) ? `<p><a href="${relativeFile(file, `ja/${doc.name}.html`)}">${h(m.site_export_source({}, o))} (ja)</a></p>` : "";
        await write(file, page(title, lang, file, source + offlineHtml(renderMarkdownOrPlain(doc.markdown, { lang, idPrefix: `${doc.name}-` }), linksFor(file, lang, "html")), nav(file, lang)));
        const sourceMd = documentKeys.has(`ja/${doc.name}`) ? `[${m.site_export_source({}, o)} (ja)](${relativeFile(mdFile, `ja/${doc.name}.md`)})\n\n` : "";
        await write(mdFile, sourceMd + offlineMarkdown(doc.markdown, linksFor(mdFile, lang, "md")));
      }
    }
    await write("index.html", page("tomola", "en", "index.html", `<h1>tomola</h1><ul>${langs.map(lang => `<li><a href="${lang}/index.html" lang="${lang}">${h(LANG_LABELS[lang])}</a></li>`).join("")}</ul>`, ""));
    const manifest = { ...exportIdentity, exportedAt: snapshot.exportedAt, requestedLanguages: requestedLangs, languages: langs,
      counts: { topics: topics.length, replies: snapshot.posts.length - topics.length, placeholders: snapshot.placeholders.length },
      posts: snapshot.posts.map(post => ({ id: post.id, threadId: post.threadId ?? post.id, title: post.title,
        language: post.lang, updatedAt: new Date(Math.max(post.changedAt.getTime(), ...langs.flatMap(lang => ["title", "body"].map(field => choose(snapshot, post, translated.get(post.id) ?? [], field as "title" | "body", lang).updatedAt.getTime())))).toISOString() })) };
    await write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    const backup = `${staging}.previous`;
    let previous = false;
    try { await fs.rename(out, backup); previous = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await fs.rename(staging, out); }
    catch (error) { if (previous) await fs.rename(backup, out); throw error; }
    if (previous) await fs.rm(backup, { recursive: true, force: true });
    return { ...manifest, files, bytes };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
