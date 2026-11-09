import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { drafts, entries, entryMentionSnapshots, notifications, profiles, stances, translations, user } from "~/lib/db/schema";
import { renderMarkdown, RENDER_VERSION } from "~/lib/markdown.server";
import * as markdownRenderer from "~/lib/markdown.core.server";
import { frozenMentionKey } from "~/lib/mentions-md.server";
import { headlineFromBody } from "~/lib/headline.server";
import { exportSite } from "~/lib/site-export.server";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { exportHref, offlineHtml, offlineMarkdown, referencedMedia, type ExportLinks } from "~/lib/site-export-format.server";
import { m } from "~/paraglide/messages.js";
import { addMember, closeTestDb, createTestDb } from "./helpers/db";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

let db: Db, temporary: string, out: string;
const ids: Record<string, number> = {};
const privateMarkers = ["private-draft-marker", "private-account-marker", "private-hidden-author", "private-deleted-author",
  "private-email-marker", "private-settings-marker", "private-hidden-topic", "private-deleted-topic",
  "private-under-hidden", "private-under-deleted", "private-hidden-reply", "private-deleted-reply", "private-hidden-translation", "private-stance-marker",
  "private-hidden-title", "private-deleted-title", "private-hidden-title-translation", "private-deleted-title-translation"];
const text = (file: string) => fs.readFile(path.join(out, file), "utf8");
async function allFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...await allFiles(file)); else found.push(file);
  }
  return found;
}
const pageOf = (lang: string, name: string, extension = "html") => text(`${lang}/t/${ids[name]}.${extension}`);
let result: Awaited<ReturnType<typeof exportSite>>;

beforeAll(async () => {
  db = await createTestDb();
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "site-export-test-"));
  out = path.join(temporary, "export");
  await addMember(db, "private-account-marker", "reader");
  await addMember(db, "hidden-account", "private-hidden-author");
  await addMember(db, "deleted-account", "private-deleted-author");
  await db.update(user).set({ name: "private-email-marker", email: "private-email-marker@example.com" }).where(eq(user.id, "private-account-marker"));
  await db.update(profiles).set({ uiLocale: "private-settings-marker" }).where(eq(profiles.userId, "private-account-marker"));
  let day = 0;
  const post = async (name: string, extra: Partial<typeof entries.$inferInsert> = {}) => {
    const [row] = await db.insert(entries).values({ kind: "topic", authorId: "private-account-marker", lang: "ja",
      title: `${name}-title`, body: `${name}-body`, sourceHash: "current-hash", createdAt: new Date(Date.UTC(2026, 0, ++day)), ...extra }).returning({ id: entries.id });
    ids[name] = row.id; return row.id;
  };
  await post("hidden", { title: "private-hidden-title", body: "private-hidden-topic", hiddenAt: new Date(), authorId: "hidden-account" });
  await post("deleted", { title: "private-deleted-title", body: "private-deleted-topic", deletedAt: new Date(), authorId: "deleted-account" });
  await post("source", { asksStance: true });
  await post("human"); await post("machine"); await post("stale"); await post("flagged");
  await post("english", { lang: "en" });
  await post("hiddenReply", { kind: "reply", title: null, threadId: ids.source, body: "private-hidden-reply", hiddenAt: new Date(), authorId: "hidden-account" });
  await post("reply", { kind: "reply", title: null, threadId: ids.source, parentId: ids.hiddenReply, lang: "en", body: "public-reply-marker" });
  await post("deletedReply", { kind: "reply", title: null, threadId: ids.source, body: "private-deleted-reply", deletedAt: new Date(), authorId: "deleted-account" });
  await post("lastReply", { kind: "reply", title: null, threadId: ids.source, parentId: ids.reply, body: "public-last-reply-marker" });
  await post("underHidden", { kind: "reply", title: null, threadId: ids.hidden, body: "private-under-hidden" });
  await post("underDeleted", { kind: "reply", title: null, threadId: ids.deleted, body: "private-under-deleted" });
  const body = `原文の試験。 $E=mc^2$\n\n[public](/t/${ids.english}?lang=en#c-${ids.reply}) [topic](/t/${ids.english}?lang=en) [reply](/t/${ids.reply}) [hidden](/t/${ids.hidden}) [deleted](/t/${ids.deleted}) [hidden reply](/t/${ids.source}#c-${ids.hiddenReply}) [member](/u/id/abcdef123456) [outside](https://example.org/read)\n\n![external image](https://example.org/image.png)\n\n<script>alert(1)</script>\n\nfootnote[^n]\n\n[^n]: reference`;
  await db.update(entries).set({ body, html: (await renderMarkdown(body, { lang: "ja", idPrefix: `p-${ids.source}-` })) + "<p>saved-render-marker</p>", htmlVersion: RENDER_VERSION }).where(eq(entries.id, ids.source));
  const tr = async (name: string, kind: string, body: string, extra: Partial<typeof translations.$inferInsert> = {}) => {
    await db.insert(translations).values({ entryId: ids[name], lang: "en", field: "body", kind, text: body, sourceHash: "current-hash", ...extra });
  };
  await tr("source", "primary", "source-english-translation");
  await tr("human", "primary", "unused-primary-marker");
  await tr("human", "human", "current-human-marker", { html: "<p>saved-human-render-marker</p>", htmlVersion: RENDER_VERSION });
  await tr("machine", "primary", "current-primary-marker");
  await tr("machine", "human", "unused-stale-human-marker", { flags: ["stale"], sourceHash: "old-hash" });
  await tr("stale", "human", "stale-human-marker", { flags: ["stale"], sourceHash: "old-hash" });
  await tr("flagged", "primary", "excluded-link-mismatch", { flags: ["link_mismatch"] });
  await tr("flagged", "primary", "excluded-untranslated", { lang: "de", flags: ["untranslated"] });
  await tr("flagged", "primary", "excluded-old-primary", { lang: "fr", sourceHash: "old-hash" });
  await tr("flagged", "primary", "excluded-mention-revision", { lang: "th", mentionRevision: 99 });
  await tr("flagged", "secondary", "excluded-secondary");
  await tr("hidden", "primary", "private-hidden-translation");
  await tr("hidden", "primary", "private-hidden-title-translation", { field: "title" });
  await tr("deleted", "primary", "private-deleted-title-translation", { field: "title" });
  await db.insert(drafts).values({ authorId: "private-account-marker", kind: "topic", lang: "en", body: "private-draft-marker" });
  await db.insert(notifications).values({ userId: "private-account-marker", actorId: "hidden-account", kind: "reply_to_topic", entryId: ids.source });
  await addMember(db, "private-stance-marker", "stance_reader");
  await db.insert(stances).values({ questionId: ids.source, userId: "private-stance-marker", position: "agree", area: "ja", version: 987654321 });
  const before = { entries: await db.select().from(entries), translations: await db.select().from(translations) };
  result = await exportSite(db, { outDir: out, langs: ["ja", "en", "fr", "de", "ko", "th"] });
  expect(await db.select().from(entries)).toEqual(before.entries);
  expect(await db.select().from(translations)).toEqual(before.translations);
  if (process.env.SITE_EXPORT_PREVIEW_DIR) await fs.cp(out, process.env.SITE_EXPORT_PREVIEW_DIR, { recursive: true });
}, 30_000);

afterAll(async () => { await closeTestDb(db); await fs.rm(temporary, { recursive: true, force: true }); });

describe("public static site export", () => {
  it("isolates display names and handles in list, post and reply HTML without exposing markup", async () => {
    const fixture = await createTestDb();
    await addMember(fixture, "rtl-export", "rtl_export");
    await fixture.update(profiles).set({ homeArea: "en", displayName: "اسم <writer>", displayNameLatin: "Latin <writer>" }).where(eq(profiles.userId, "rtl-export"));
    const [topic] = await fixture.insert(entries).values({ kind: "topic", authorId: "rtl-export", lang: "en", title: "Export names", body: "Post" }).returning();
    await fixture.insert(entries).values({ kind: "reply", authorId: "rtl-export", threadId: topic.id, parentId: topic.id, lang: "en", body: "Reply" });
    const target = path.join(temporary, "bidi-export");
    await exportSite(fixture, { outDir: target, langs: ["en", "ja"] });
    for (const [lang, name] of [["en", "اسم &lt;writer&gt;"], ["ja", "Latin &lt;writer&gt;"]]) {
      const index = await fs.readFile(path.join(target, lang, "index.html"), "utf8");
      const html = await fs.readFile(path.join(target, lang, `t/${topic.id}.html`), "utf8");
      expect(index).toContain(`<bdi>${name}</bdi>`);
      expect(html.match(new RegExp(`<bdi>${name}</bdi> <bdi>@rtl_export</bdi>`, "g"))).toHaveLength(2);
      expect(html).not.toContain("<writer>");
    }
  });
  it("typesets machine HTML with missing, stale or current caches while keeping exported Markdown and authored text unchanged", async () => {
    const fixture = await createTestDb();
    await addMember(fixture, "typeset-export", "typeset_export");
    const raw = '"Bonjour"... n\'a: oui!';
    const shown = '«\u00a0Bonjour\u00a0»… n’a\u00a0: oui\u202f!';
    const cases = ["missing", "stale", "current", "human", "source"] as const;
    const ids = new Map<string, number>();
    const target = path.join(temporary, "typeset-export");
    const content = path.join(temporary, "typeset-export-content");
    await fs.mkdir(content);
    try {
      for (const name of cases) {
        const [post] = await fixture.insert(entries).values({ kind: "topic", authorId: "typeset-export", lang: name === "source" ? "fr" : "ja", title: name === "source" ? raw : "原題", body: name === "source" ? raw : "原文", sourceHash: "export-source" }).returning();
        ids.set(name, post.id);
        if (name === "source") continue;
        const html = name === "current" ? await renderMarkdown(raw, { lang: "fr", idPrefix: `p-${post.id}-fr-`, translation: true }) : name === "stale" ? "<p>stale render</p>" : null;
        await fixture.insert(translations).values([
          { entryId: post.id, field: "title", lang: "fr", kind: name === "human" ? "human" : "primary", text: raw, sourceHash: post.sourceHash, mentionRevision: post.mentionRevision },
          { entryId: post.id, field: "body", lang: "fr", kind: name === "human" ? "human" : "primary", text: raw, sourceHash: post.sourceHash, mentionRevision: post.mentionRevision, html, htmlVersion: name === "current" ? RENDER_VERSION : name === "stale" ? RENDER_VERSION - 1 : 0 },
        ]);
      }
      const before = await fixture.select().from(translations);
      await exportSite(fixture, { outDir: target, langs: ["fr"], contentDir: content });
      expect(await fixture.select().from(translations)).toEqual(before);
      for (const name of cases) {
        const id = ids.get(name)!;
        const html = await fs.readFile(path.join(target, `fr/t/${id}.html`), "utf8");
        const markdown = await fs.readFile(path.join(target, `fr/t/${id}.md`), "utf8");
        if (name === "human" || name === "source") {
          expect(html).toContain(`<p>${raw}</p>`);
          expect(html).not.toContain(shown);
        } else {
          expect(html).toContain(`<p>${shown}</p>`);
          expect(html).toContain(`<h1 lang="fr">${shown}</h1>`);
          expect(html).not.toContain("stale render");
        }
        expect(markdown).toContain(raw);
        expect(markdown).not.toContain(shown);
      }
      const index = await fs.readFile(path.join(target, "fr/index.html"), "utf8");
      expect(index).toContain(`t/${ids.get("missing")}.html">${shown}</a>`);
    } finally { await closeTestDb(fixture); }
  });
  it("writes the language indexes, manifest, threads, Markdown and local math assets", async () => {
    expect(await text("index.html")).toContain('href="ja/index.html"');
    expect(await text("ja/index.html")).toContain(`t/${ids.source}.html`);
    const index = await text("en/index.html");
    expect(index.indexOf(`t/${ids.english}.html`)).toBeLessThan(index.indexOf(`t/${ids.source}.html`));
    expect(await pageOf("ja", "source")).toContain("saved-render-marker");
    expect(await pageOf("ja", "source")).toContain('class="katex"');
    expect(await pageOf("ja", "source", "md")).toContain("E=mc^2");
    expect(await text("assets/katex.min.css")).toContain("fonts/");
    expect(await text("assets/KaTeX-LICENSE.txt")).toContain("MIT");
    expect((await fs.readdir(path.join(out, "assets/fonts"))).length).toBeGreaterThan(0);
    expect(JSON.parse(await text("manifest.json")).counts).toEqual({ topics: 6, replies: 2, placeholders: 1 });
    expect(result.posts.every(post => Number.isFinite(Date.parse(post.updatedAt)))).toBe(true);
  });

  it("uses the original, current human, current primary, stale human and missing states", async () => {
    expect(await pageOf("ja", "source")).toContain('data-status="source"');
    expect(await pageOf("en", "source")).toContain("source-english-translation");
    expect(await pageOf("en", "human")).toContain("saved-human-render-marker");
    expect(await pageOf("en", "human", "md")).toContain("current-human-marker");
    expect(await pageOf("en", "machine")).toContain("current-primary-marker");
    const stale = await pageOf("en", "stale");
    expect(stale).toContain('data-status="stale"');
    expect(stale).toContain(m.site_export_stale({}, { locale: "en" }));
    const missing = await pageOf("ko", "source");
    expect(missing).toContain('data-status="missing"');
    expect(missing).toContain(m.site_export_missing({}, { locale: "ko" }));
    for (const lang of ["en", "de", "fr", "th"]) expect(await pageOf(lang, "flagged")).toContain('data-status="missing"');
  });

  it("excludes every private marker and disallowed translation from the entire export", async () => {
    for (const file of await allFiles(out)) {
      const contents = (await fs.readFile(file)).toString();
      for (const marker of [...privateMarkers, "987654321", "excluded-", "unused-primary-marker", "unused-stale-human-marker"]) expect(contents, path.relative(out, file)).not.toContain(marker);
    }
    for (const lang of result.languages) {
      for (const id of [ids.hidden, ids.deleted, ids.underHidden, ids.underDeleted]) {
        expect(await text(`${lang}/index.html`)).not.toContain(`t/${id}.html`);
        await expect(fs.stat(path.join(out, lang, "t", `${id}.html`))).rejects.toThrow();
      }
    }
    for (const id of [ids.hidden, ids.deleted, ids.underHidden, ids.underDeleted, ids.hiddenReply, ids.deletedReply]) expect(result.posts.map(post => post.id)).not.toContain(id);
    expect(result.posts.map(post => post.id)).toEqual(expect.arrayContaining([ids.source, ids.reply]));
  });

  it("keeps redacted reply positions and parent links in chronological order", async () => {
    const html = await pageOf("en", "source"), md = await pageOf("en", "source", "md");
    const order = [ids.hiddenReply, ids.reply, ids.lastReply].map(id => html.indexOf(`id="c-${id}"`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain(`href="#c-${ids.hiddenReply}"`);
    expect(html).toContain(`href="#c-${ids.reply}"`);
    expect(md).toContain(m.entry_hidden_placeholder({}, { locale: "en" }));
    expect(html).not.toContain(`id="c-${ids.deletedReply}"`);
    expect(md).not.toContain(`id="c-${ids.deletedReply}"`);
    expect(md).not.toContain(m.entry_deleted_placeholder({}, { locale: "en" }));
    expect(md).not.toContain("private-hidden-author");
  });

  it("rewrites public links and removes unavailable post and member links", async () => {
    const html = await pageOf("ja", "source"), md = await pageOf("ja", "source", "md");
    expect(html).toContain(`href="${ids.english}.html"`);
    expect(html).toContain(`href="${ids.source}.html#c-${ids.reply}"`);
    expect(html).not.toContain("/u/id/");
    expect(html).not.toContain(`href="/t/${ids.hidden}"`);
    expect(html).toContain('href="https://example.org/read"');
    expect(md).toContain(`(<${ids.english}.md>)`);
    expect(md).not.toContain("/u/id/");
    expect(md).not.toContain(`/t/${ids.hidden}`);
  });

  it("contains no script or external resource loads in any HTML or stylesheet", async () => {
    for (const file of await allFiles(out)) {
      if (!/\.(html|css)$/.test(file)) continue;
      const contents = await fs.readFile(file, "utf8");
      expect(contents).not.toMatch(/<script\b/i);
      expect(contents).not.toMatch(/<(?:img|iframe|script|link)[^>]+(?:src|href)=["'](?:https?:)?\/\//i);
      expect(contents).not.toMatch(/url\(["']?(?:https?:)?\/\//i);
    }
  });

  it("exports site documents only where an edition exists, with offline navigation", async () => {
    for (const lang of result.languages) {
      expect(await text(`${lang}/principles.html`)).toContain(`lang="${lang}"`);
      expect(await text(`${lang}/principles.md`)).toContain("#");
      for (const name of ["why", "name"]) {
        const source = await fs.readFile(path.join(process.cwd(), "app/content", name, `${lang}.md`), "utf8");
        const title = source.match(/^# (.+)$/m)![1];
        const signature = source.trimEnd().split("\n").at(-1)!;
        expect(await text(`${lang}/${name}.html`)).toContain(`lang="${lang}"`);
        expect(await text(`${lang}/${name}.md`)).toContain(`# ${title}`);
        expect(await text(`${lang}/${name}.md`)).toContain(signature);
      }
      expect(await text(`${lang}/index.html`)).toContain('href="why.html"');
      for (const file of ["index.html", "principles.html", "why.html", "name.html", `t/${ids.source}.html`]) {
        const html = await text(`${lang}/${file}`);
        const nav = html.match(/<body><nav>([\s\S]*?)<\/nav>/)![1];
        expect(nav).not.toMatch(/href="[^"]*\bname\.html"/);
      }
    }
    expect(await text("en/why.html")).toContain('href="principles.html"');
    expect(await text("en/name.html")).toContain('href="why.html"');
    expect(exportHref("/name?lang=ja", { page: "en/t/1.html", lang: "en", extension: "html", posts: new Map(), documents: new Set(["en/name"]) })).toBe("../name.html");
    expect(await offlineMarkdown("[name](/name.md)", { page: "en/t/1.md", lang: "en", extension: "md", posts: new Map(), documents: new Set(["en/name"]) })).toBe("[name](<../name.md>)");
  });

  it("preserves the previous output after a failure partway through generation", async () => {
    await fs.appendFile(path.join(out, "assets/site.css"), "\n/* previous export marker */\n");
    const hashes = async () => Promise.all((await allFiles(out)).sort().map(async file => ({ file: path.relative(out, file), hash: createHash("sha256").update(await fs.readFile(file)).digest("hex") })));
    const before = await hashes();
    await expect(exportSite(db, { outDir: out, langs: ["ja", "en"], katexDir: path.join(temporary, "missing-assets") })).rejects.toThrow();
    expect(await hashes()).toEqual(before);
    expect((await fs.readdir(temporary)).filter(name => name.includes(".tmp-"))).toEqual([]);
  });

  it("replaces a marked export using enabled languages without adding source directories", async () => {
    const replacement = path.join(temporary, "replacement");
    await fs.mkdir(replacement); // An existing empty directory is allowed.
    await exportSite(db, { outDir: replacement, langs: ["ja", "en"] });
    await fs.writeFile(path.join(replacement, "obsolete.html"), "old");
    vi.stubEnv("ENABLED_LANGS", "ko");
    try {
      const exported = await exportSite(db, { outDir: replacement });
      expect(exported.requestedLanguages).toEqual(["ko"]);
      expect(exported.languages).toEqual(["ko"]);
      expect(exported).toMatchObject({ format: "tomola-public-site", version: 1 });
      await expect(fs.stat(path.join(replacement, "obsolete.html"))).rejects.toThrow();
      await expect(fs.stat(path.join(replacement, "ja"))).rejects.toThrow();
      await expect(fs.stat(path.join(replacement, "en"))).rejects.toThrow();
      const html = await fs.readFile(path.join(replacement, "ko/t", `${ids.source}.html`), "utf8");
      expect(html).toContain('data-status="missing"');
      expect(html).not.toContain(`../../ja/t/${ids.source}.html`);
    } finally { vi.unstubAllEnvs(); }
  });

  it("excludes closed-language translations everywhere, including explicit language requests", async () => {
    const closed = await createTestDb();
    await addMember(closed, "closed-language-writer", "closed_writer");
    const [source, other] = await closed.insert(entries).values([
      { kind: "topic", authorId: "closed-language-writer", lang: "th", title: "closed-source-title", body: "closed-source-body", sourceHash: "hash" },
      { kind: "topic", authorId: "closed-language-writer", lang: "ja", title: "open-source-title", body: "open-source-body", sourceHash: "hash" },
    ]).returning();
    await closed.insert(translations).values([
      { entryId: other.id, lang: "th", field: "body", kind: "primary", text: "closed-translation-body-marker", sourceHash: "hash" },
      { entryId: other.id, lang: "th", field: "title", kind: "primary", text: "closed-translation-title-marker", sourceHash: "hash" },
      { entryId: source.id, lang: "en", field: "body", kind: "primary", text: "enabled-translation-marker", sourceHash: "hash" },
    ]);
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    try {
      const target = path.join(temporary, "closed");
      const exported = await exportSite(closed, { outDir: target, langs: ["ja", "en", "th"] });
      expect(exported.languages).toEqual(["ja", "en"]);
      await expect(fs.stat(path.join(target, "th"))).rejects.toThrow();
      for (const file of await allFiles(target)) expect((await fs.readFile(file)).toString(), file).not.toContain("closed-translation-");
      const ja = await fs.readFile(path.join(target, "ja/t", `${source.id}.html`), "utf8");
      expect(ja).toContain("closed-source-body");
      expect(ja).toContain('data-status="missing"');
      expect(ja).not.toContain("../../th/");
      expect(await fs.readFile(path.join(target, "en/t", `${source.id}.html`), "utf8")).toContain("enabled-translation-marker");
      await expect(exportSite(closed, { outDir: path.join(temporary, "closed-only"), langs: ["th"] })).rejects.toThrow("enabled language");
      await expect(fs.stat(path.join(temporary, "closed-only"))).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });

  it("uses source or translated body headlines for titleless topics and keeps null in the manifest", async () => {
    const bare = await createTestDb();
    await addMember(bare, "bare-writer", "bare_writer");
    const body = "**source headline**\n\nsource second paragraph", translatedBody = "**translated headline**\n\ntranslated second paragraph";
    const [topic] = await bare.insert(entries).values({ kind: "topic", authorId: "bare-writer", lang: "ja", title: null, body, sourceHash: "hash" }).returning();
    await bare.insert(translations).values({ entryId: topic.id, lang: "en", field: "body", kind: "primary", text: translatedBody, sourceHash: "hash" });
    const target = path.join(temporary, "titleless");
    const exported = await exportSite(bare, { outDir: target, langs: ["ja", "en"] });
    expect(exported.posts[0].title).toBeNull();
    for (const [lang, markdown] of [["ja", body], ["en", translatedBody]]) {
      const headline = (await headlineFromBody(markdown));
      expect(await fs.readFile(path.join(target, lang, "index.html"), "utf8")).toContain(headline);
      expect(await fs.readFile(path.join(target, lang, "t", `${topic.id}.html`), "utf8")).toContain(`<h1 lang="${lang}">${headline}</h1>`);
      expect(await fs.readFile(path.join(target, lang, "t", `${topic.id}.md`), "utf8")).toContain(`# ${headline}\n`);
    }
  });

  it("renders missing caches with the frozen mention targets for each source and translation revision", async () => {
    const mentions = await createTestDb();
    await addMember(mentions, "mention-writer", "mention_writer");
    await addMember(mentions, "original-recipient", "old_name");
    const [topic] = await mentions.insert(entries).values({ kind: "topic", authorId: "mention-writer", lang: "ja", body: "@old_name source", sourceHash: "new-hash", mentionRevision: 2 }).returning();
    await mentions.insert(entryMentionSnapshots).values([1, 2].map(revision => ({ entryId: topic.id, revision, sourceHash: revision === 1 ? "old-hash" : "new-hash", body: "@old_name source",
      bindings: [{ spelling: "@old_name", prefix: revision === 1 ? "old_name" : null, userId: revision === 1 ? "original-recipient" : null }] })));
    await mentions.insert(translations).values({ entryId: topic.id, lang: "en", field: "body", kind: "human", text: "@old_name translation", sourceHash: "old-hash", mentionRevision: 1, flags: ["stale"] });
    await mentions.update(profiles).set({ handle: "renamed", handleKey: "renamed" }).where(eq(profiles.userId, "original-recipient"));
    const renderer = vi.spyOn(markdownRenderer, "renderMarkdownOrPlain");
    try {
      const target = path.join(temporary, "mentions");
      await exportSite(mentions, { outDir: target, langs: ["ja", "en"] });
      const sourceOptions = renderer.mock.calls.find(([text]) => text === "@old_name source")?.[1];
      const translationOptions = renderer.mock.calls.find(([text]) => text === "@old_name translation")?.[1];
      expect(sourceOptions?.mentions?.get(frozenMentionKey("@old_name"))).toMatchObject({ prefix: null, userId: "" });
      expect(translationOptions?.mentions?.get(frozenMentionKey("@old_name"))).toMatchObject({ prefix: "old_name", userId: "original-recipient" });
      for (const lang of ["ja", "en"]) {
        const html = await fs.readFile(path.join(target, lang, "t", `${topic.id}.html`), "utf8");
        expect(html).toContain("@old_name");
        expect(html).not.toContain("/u/id/");
        expect(html).not.toContain("original-recipient");
      }
    } finally { renderer.mockRestore(); }
  });

  it.each([null, "invalid JSON", JSON.stringify({ format: "other-export", version: 1 }), JSON.stringify({ format: "tomola-public-site", version: 99 })])("refuses an unrelated nonempty directory and preserves all its files: %s", async manifest => {
    const target = await fs.mkdtemp(path.join(temporary, "unrelated-"));
    await fs.writeFile(path.join(target, "keep.txt"), "keep-marker");
    if (manifest !== null) await fs.writeFile(path.join(target, "manifest.json"), manifest);
    await expect(exportSite(db, { outDir: target, langs: ["ja"] })).rejects.toThrow("manifest marker");
    expect(await fs.readFile(path.join(target, "keep.txt"), "utf8")).toBe("keep-marker");
    expect((await fs.readdir(target)).sort()).toEqual(manifest === null ? ["keep.txt"] : ["keep.txt", "manifest.json"]);
    if (manifest !== null) expect(await fs.readFile(path.join(target, "manifest.json"), "utf8")).toBe(manifest);
  });

  it("exports replies beyond the live page size without pagination", async () => {
    const many = await createTestDb();
    await addMember(many, "many-writer", "many_writer");
    const [topic] = await many.insert(entries).values({ kind: "topic", authorId: "many-writer", lang: "ja", body: "topic" }).returning({ id: entries.id });
    const replies = await many.insert(entries).values(Array.from({ length: 106 }, (_, n) => ({ kind: "reply", authorId: "many-writer", lang: "ja", threadId: topic.id, body: `reply-${n}`, createdAt: new Date(2026, 0, 1, 0, 0, n) }))).returning({ id: entries.id });
    const target = path.join(temporary, "many"), emptyContent = path.join(temporary, "empty-content");
    await fs.mkdir(emptyContent);
    const exported = await exportSite(many, { outDir: target, langs: ["ja"], contentDir: emptyContent });
    expect(exported.counts.replies).toBe(106);
    const html = await fs.readFile(path.join(target, "ja/t", `${topic.id}.html`), "utf8");
    expect(html).toContain(`id="c-${replies[105].id}"`);
    expect(html.indexOf(`id="c-${replies[0].id}"`)).toBeLessThan(html.indexOf(`id="c-${replies[105].id}"`));
  });
});

describe("offline link conversion", () => {
  const links: ExportLinks = { page: "en/t/1.html", lang: "en", extension: "html", posts: new Map([[1, 1], [2, 1], [3, 3]]), documents: new Set(["en/principles"]), origin: "https://example.com" };
  it("handles same-site absolute links, query strings, references and code without loading images", async () => {
    expect(offlineHtml('<p><a href="https://example.com/t/3?lang=ja&amp;x=y">next</a> <a href="/t/1#c-2">reply</a> <a href="/t/99">gone</a></p><img src="/upload.png" alt="image">', links)).toContain('href="3.html"');
    expect((await offlineMarkdown('[next][ref] [gone](/t/99) `[/t/99](/t/99)`\n\n[ref]: /t/3?lang=ja', { ...links, extension: "md" }))).toBe('[next](<3.md>) gone `[/t/99](/t/99)`\n\n');
    expect(offlineHtml('<p><a class="mention" href="/u/id/abcdef123456">@member</a></p>', links)).toBe("<p>@member</p>");
  });
  it("rewrites bare URLs and links inside labels without parsing a label again", async () => {
    const md = { ...links, extension: "md" as const };
    // A bare URL is a link whose label is the URL itself. An external one stays as written.
    const external = "see https://example.org/x here, <https://example.org/y>, www.example.org and a@example.org";
    expect((await offlineMarkdown(external, md))).toBe(external);
    // A same-site one becomes a link to the exported file, or stays as written. A <URL> with a scheme that links must not use loses its brackets.
    expect((await offlineMarkdown("https://example.com/t/3 https://example.com/t/99 <https://example.com/u/a_b> <javascript:alert(1)>", md))).toBe("[https://example.com/t/3](<3.md>) https://example.com/t/99 <https://example.com/u/a_b> javascript:alert(1)");
    // A link cannot hold another link: a nested image leaves its alternative text, and only the outer target remains.
    expect((await offlineMarkdown("[![badge](https://example.org/i.png) text](/t/3)", md))).toBe("[badge text](<3.md>)");
    expect((await offlineMarkdown("\uFEFF[a](/t/3) $f[x](t) + a<b>c$", md))).toBe("[a](<3.md>) $f[x](t) + a<b>c$");
  });
  it.each([
    ["[x](<https://example.org/ \\<img src=x onerror=alert(1)\\>>)", ["link:https://example.org/ <img src=x onerror=alert(1)>"]],
    ["![<img src=x onerror=alert(1)> `c` [d]](https://example.org/i.png)", ["link:https://example.org/i.png"]],
    ["https://example.org/p![x](/i.png) https://example.org/a[b", ["link:https://example.org/p![x", "link:https://example.org/a[b"]],
    ["https://example.com/t/3?x=![a](https://example.org/i.png) tail", ["link:3.md", "link:https://example.org/i.png"]],
    ["| a |\n|---|\n| ![x\\|y](https://example.org/i.png) https://example.com/t/3 |", ["link:https://example.org/i.png", "link:3.md"]],
    // Text on both sides of an edit must not join into markup.
    ["Look!![x](https://example.org/i.png) [hi!](/u/id/abc)![y](https://example.org/j.png)", ["link:https://example.org/i.png", "link:https://example.org/j.png"]],
    ["<<b>img src=x onerror=alert(1)> [d](/t/99)https://example.org/x?![a](https://example.org/i.png)", []],
    ["[[a](/t/99)](javascript:alert(1)) <b>[c]</b>(/u/id/abc) <<b>javascript:alert(1)>", []],
    ["[a](<https://example.org/a&#10;b>)", ["link:https://example.org/a%0Ab"]],
  ])("adds no image, raw HTML or link when it writes labels and destinations: %s", async (input, expected) => {
    const found: string[] = [];
    const walk = (node: { type: string; url?: string; children?: unknown[] }): void => {
      if (["link", "image", "html", "definition", "linkReference", "imageReference"].includes(node.type)) found.push(`${node.type}:${node.url ?? ""}`);
      (node.children as typeof node[] | undefined)?.forEach(walk);
    };
    walk(unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse((await offlineMarkdown(input, { ...links, extension: "md" }))));
    expect(found).toEqual(expected);
  });
  it.each([
    "a><b>bold</b><a href=javascript:alert(1)>click",
    "a><form action=https://example.org><input style=background:url(https://example.org/x)>",
    "><svg><a xlink:href=x><script>alert(1)</script>",
    "literal onload=x srcdoc=x style=url(https://example.org/x)",
    "literal href=/t/99 alt=example > text",
  ])("keeps quoted link titles inert when removing or retaining a link: %s", async title => {
    const removed = (await renderMarkdown(`[x](/t/99 "${title}")`));
    expect(removed).toContain('title="');
    expect(offlineHtml(removed, links)).toBe("<p>x</p>");
    const retained = (await renderMarkdown(`[x](https://example.org/read "${title}")`));
    expect(offlineHtml(retained, links)).toBe(retained);
  });
  it("turns quoted image alt text into escaped text without adding elements", async () => {
    const saved = (await renderMarkdown(String.raw`![a\><b\>bold\</b\> & text](/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-12x8.webp)`));
    expect(saved).toContain('<img ');
    expect(offlineHtml(saved, links)).toBe("<p>a&gt;&lt;b&gt;bold&lt;/b&gt; &amp; text</p>");
    expect(offlineHtml('<img src="/image.png" alt="> <script> onload=x" title="alt=wrong > text">', links)).toBe("&gt; &lt;script&gt; onload=x");
  });
  it("preserves generated KaTeX SVG, styles and footnote elements", async () => {
    const saved = (await renderMarkdown("$\\sqrt{x}$ $\\widehat{x+y}$\n\nreference[^n]\n\n[^n]: note"));
    expect(saved).toContain("<svg");
    expect(saved).toContain('style="');
    expect(offlineHtml(saved, links)).toBe(saved);
    const error = (await renderMarkdown("[$\\frac{</a><img src=x><b>bad</b>}$](/t/99)"));
    expect(error).toContain('class="katex-error"');
    expect(offlineHtml(error, links)).toBe((await renderMarkdown("$\\frac{</a><img src=x><b>bad</b>}$")));
  });
  it("refuses active saved HTML and unsafe destination paths", async () => {
    expect(offlineHtml('<pre><code>onclick = handler; url(example)</code></pre>', links)).toContain("onclick = handler");
    expect(() => offlineHtml('<script src="https://example.org/x"></script>', links)).toThrow();
    await expect(exportSite(db, { outDir: "/" })).rejects.toThrow();
    await fs.writeFile(path.join(temporary, "file"), "old");
    await expect(exportSite(db, { outDir: path.join(temporary, "file") })).rejects.toThrow();
  });
});


it("exported media cannot retain alternate external image sources", () => {
  const src = `/media/${"a".repeat(64)}-12x8.webp`;
  const links: ExportLinks = { page: "en/t/1.html", lang: "en", extension: "html", posts: new Map(), documents: new Set(), media: new Map([["a".repeat(64), "assets/media/a.webp"]]) };
  const html = offlineHtml(`<img src="${src}" alt="figure" srcset="https://outside.example/tracker.webp 2x" longdesc="https://outside.example/description">`, links);
  expect(html).toContain('src="../../assets/media/a.webp"');
  expect(html).not.toContain("outside.example"); expect(html).not.toContain("srcset");
  expect(offlineHtml('<img src="https://outside.example/a.webp" alt="outside">', links)).toBe("outside");
});


it("exports the first definition of a managed image reference", async () => {
  const id = "a".repeat(64), second = "b".repeat(64);
  const md = `![figure][asset]\n\n[asset]: /media/${id}-12x8.webp\n[asset]: /media/${second}-12x8.webp`;
  const links: ExportLinks = { page: "en/t/1.md", lang: "en", extension: "md", posts: new Map(), documents: new Set(), media: new Map([[id, "assets/media/a.webp"]]) };
  expect((await referencedMedia(md))).toEqual([id]);
  expect((await offlineMarkdown(md, links))).toContain("![figure](<../../assets/media/a.webp>)");
});
