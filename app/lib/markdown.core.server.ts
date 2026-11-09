import { createMarkdownProcessor } from "~/lib/markdown-parser.core.server";
import { MEDIA_LIMITS, parseMediaImage } from "~/lib/media";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { buildCardTree, cardPlainText, CARD_MAX_BLOCKS, CARD_MAX_CHARS } from "~/lib/card-excerpt.server";
import { remarkMentions, type MentionTargets } from "~/lib/mentions-md.core.server";
import { siteUrl } from "~/lib/site-url";
import { rehypeTypesetText } from "~/lib/typeset-markdown.core.server";
import { m } from "~/paraglide/messages.js";
import { baseLocale, isLocale, type Locale } from "~/paraglide/runtime.js";
import { draftExcerpt, MAX_DRAFT_ISSUES, type DraftIssue } from "~/lib/draft-issues";

// remark-math produces code elements with class="language-math math-inline|math-display".
// Keep those through sanitization, then render with rehype-katex; KaTeX output is outside sanitization.
// clobber: remark-rehype already prefixes footnote ids with user-content-. Default id/name clobbering
// would double-prefix ids, breaking hrefs. Exclude id and prefix only name.
// Clobbering only name is safe because raw HTML is dropped: neither allowDangerousHtml nor rehype-raw is used.
// Revisit clobbering, including id, if allowing raw HTML, to prevent DOM clobbering.
const sanitizeSchema: SanitizeOptions = {
  ...defaultSchema,
  clobber: ["name"],
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
    span: [["lang", "en"]],
    // Preserve only the generated mention class on links, alongside the ordinary Markdown link attributes.
    a: [
      ...(defaultSchema.attributes?.a ?? []).filter((attribute) => !Array.isArray(attribute) || attribute[0] !== "className"),
      ["className", "data-footnote-backref", "mention"],
    ],
  },
};

// Bump when rendering changes: plugins, sanitization, KaTeX, footnote-prefix rules, etc.
// Caches with a different entries.html_version are regenerated and saved on display.
// 2: external images became links (rehypeExternalImages); footnote headings and 「参照へ戻る」 now use the body language lang.
// 3: an @mention of a member becomes an emphasized span (class="mention"; remarkMentions). The members are looked up when the body is rendered.
// 4: topic body and card HTML share one mention-aware render and one cache version.
// 5: saved mention bindings render immutable member links in both full bodies and cards.
// 6: body headings receive sequential, post-specific anchors after sanitization.
// 7: only managed media paths render images, with dimensions and a per-post limit.
// 8: KaTeX 0.19 renamed several classes in its output (base, strut, sizing); saved renders must match the stylesheet shipped with it.
// 9: CJK emphasis and double-tilde strikethrough.
// 10: machine-translation typography and English word language spans in CJK bodies.
// 11: lexical CJK URL boundaries and source positions around literal autolinks.
export const RENDER_VERSION = 11;

const DEFAULT_ID_PREFIX = "user-content-";

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
  position?: { start: { line: number; offset?: number }; end: { offset?: number } };
};

// Restrict generated member links without narrowing the destinations of ordinary Markdown links. Raw HTML is already excluded by remark-rehype.
function rehypeMentionLinks() {
  const walk = (node: HastNode): void => {
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const classes = child.properties?.className;
      if (child.tagName === "a" && Array.isArray(classes) && classes.includes("mention")) {
        const href = child.properties?.href;
        if (typeof href !== "string" || !/^\/u\/id\/[a-z0-9]{12}$/.test(href)) {
          const text = child.children ?? [];
          children.splice(i, 1, ...text);
          i += text.length - 1;
          continue;
        }
      }
      walk(child);
    }
  };
  return (tree: HastNode) => walk(tree);
}

// remark-rehype fixes footnote heading id footnote-label and reference aria-describedby;
// neither clobberPrefix nor footnoteLabelProperties affects them. Prefix here to avoid duplicates across posts on one page.
function rehypePrefixFootnoteLabel(options: { prefix: string }) {
  const label = "footnote-label";
  const walk = (node: HastNode): void => {
    const props = node.properties;
    if (props) {
      if (props.id === label) props.id = options.prefix + label;
      if (Array.isArray(props.ariaDescribedBy)) {
        props.ariaDescribedBy = props.ariaDescribedBy.map((v) => (v === label ? options.prefix + label : v));
      }
    }
    node.children?.forEach(walk);
  };
  return (tree: HastNode) => walk(tree);
}

// Do not load external images: that exposes the reader's IP and visit to third parties. CSP img-src 'self' data: follows the same policy.
// Replace off-origin <img> with <a href=src rel="nofollow noopener noreferrer">alt text, or the URL if absent</a>.
// Images inside links become text only to avoid nested links. Images without src (sanitization drops data: src) also become alt text only.
// Only managed media paths, rooted or at the site origin, may load an image. Other paths stay ordinary links.
function siteOrigin(): string | null {
  try {
    return new URL(siteUrl()).origin;
  } catch {
    return null;
  }
}

export function mediaImage(src: string, origin: string | null = siteOrigin()) {
  return parseMediaImage(src, origin);
}

function rehypeExternalImages(options?: { removed?: (node: HastNode) => void }) {
  let shown = 0;
  const walk = (node: HastNode, insideLink: boolean): void => {
    const children = node.children;
    if (!children) return;
    const link = insideLink || node.tagName === "a";
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type === "element" && child.tagName === "img") {
        const src = typeof child.properties?.src === "string" ? child.properties.src : "";
        const alt = typeof child.properties?.alt === "string" ? child.properties.alt.trim() : "";
        const media = mediaImage(src);
        if (media && shown < MEDIA_LIMITS.perPost) {
          shown++;
          child.properties = { ...child.properties, width: media.width, height: media.height, loading: "lazy", decoding: "async" };
          continue;
        }
        options?.removed?.(child);
        const text: HastNode = { type: "text", value: alt || src };
        if (src === "" || link) {
          // Text only; leave nothing if both alt and src are absent.
          if (text.value) children.splice(i, 1, text);
          else children.splice(i--, 1);
        } else {
          children[i] = { type: "element", tagName: "a", properties: { href: src, rel: ["nofollow", "noopener", "noreferrer"] }, children: [text] };
        }
        continue;
      }
      walk(child, link);
    }
  };
  return (tree: HastNode) => { shown = 0; walk(tree, false); };
}

// remark-rehype uses fixed English for the sr-only h2 footnote heading and 「参照へ戻る」 aria-label. Use the body language lang (post language for originals, target language for translations)
// to match the body's div lang for screen readers, keeping cached rendering independent of the reader's interface locale.
function footnoteOptions(lang: string | undefined) {
  const locale: Locale = lang !== undefined && isLocale(lang) ? lang : baseLocale;
  const o = { locale };
  return {
    footnoteLabel: m.md_footnotes({}, o) || "Footnotes",
    footnoteBackLabel: (referenceIndex: number, rereferenceIndex: number) => {
      // Same numbering as remark-rehype: referenceIndex starts at 0, rereferenceIndex at 1; 「1」, then 「1-2」 for repeated references to the same note.
      const index = rereferenceIndex > 1 ? `${referenceIndex + 1}-${rereferenceIndex}` : String(referenceIndex + 1);
      return m.md_footnote_back({ index }, o) || `Back to reference ${index}`;
    },
  };
}

// The part of the pipeline up to the sanitized, external-image-free tree (hast). The card version is cut from this tree (before KaTeX), so that a formula is never cut in the middle.
function rehypeHeadingIds(options: { prefix: string }) {
  return (tree: HastNode) => {
    let index = 0;
    const walk = (node: HastNode): void => {
      // The generated footnote label keeps its own anchor and is not a body heading.
      if (/^h[1-4]$/.test(node.tagName ?? "") && node.properties?.id !== options.prefix + "footnote-label" && !String(node.properties?.id ?? "").endsWith("footnote-label")) {
        node.properties = { ...node.properties, id: `${options.prefix}h-${++index}` };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

function createFrontProcessor(idPrefix: string, lang: string | undefined, headingIdPrefix: string | undefined, translation = false, diagnostics?: { before: (tree: HastNode) => void; after: (tree: HastNode) => void; image: (node: HastNode) => void }) {
  const processor = createMarkdownProcessor()
    .use(remarkMentions)
    .use(remarkRehype, { clobberPrefix: idPrefix, ...footnoteOptions(lang) })
    .use(rehypeMentionLinks)
    .use(rehypePrefixFootnoteLabel, { prefix: idPrefix });
  if (diagnostics) processor.use(() => diagnostics.before);
  processor.use(rehypeSanitize, sanitizeSchema);
  if (diagnostics) processor.use(() => diagnostics.after);
  processor
    .use(rehypeTypesetText, { lang, translation });
  if (headingIdPrefix !== undefined) processor.use(rehypeHeadingIds, { prefix: headingIdPrefix });
  return processor.use(rehypeExternalImages, { removed: diagnostics?.image });
}

// Observe the publishing pipeline; diagnostics never make a separate URL or image-policy decision.
export function inspectDraftRendering(markdown: string, lang: string) {
  const issues: DraftIssue[] = [];
  const images: Array<{ src: string; line: number; excerpt: string }> = [];
  const links = new Map<number, HastNode>();
  const walk = (node: HastNode, visit: (node: HastNode) => void): void => { visit(node); node.children?.forEach(child => walk(child, visit)); };
  const add = (kind: DraftIssue["kind"], node: HastNode, message: string) => {
    if (issues.length > MAX_DRAFT_ISSUES) return;
    issues.push({ kind, location: { field: "body", line: node.position?.start.line ?? 1 }, excerpt: draftExcerpt(markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0)), message });
  };
  const processor = createFrontProcessor(DEFAULT_ID_PREFIX, lang, undefined, false, {
    before: tree => walk(tree, node => { if (node.tagName === "a" && typeof node.properties?.href === "string" && node.position?.start.offset !== undefined) links.set(node.position.start.offset, node); }),
    after: tree => walk(tree, node => {
      if (node.tagName === "a" && node.position?.start.offset !== undefined && links.has(node.position.start.offset) && typeof node.properties?.href !== "string") {
        add("link_removed", links.get(node.position.start.offset)!, "This link's destination is removed during sanitization. Use an allowed URL if a link is intended.");
      }
    }),
    image: node => add("image_not_rendered", node, "This image becomes a link or text. Use uploaded media within the per-post image limit if an image is intended."),
  });
  const file = { value: markdown, data: {} };
  const tree = processor.runSync(processor.parse(file), file);
  walk(tree, node => {
    if (node.tagName === "img" && typeof node.properties?.src === "string") images.push({ src: node.properties.src, line: node.position?.start.line ?? 1, excerpt: draftExcerpt(markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0)) });
  });
  return { issues, images };
}

// The rest: KaTeX and the string. maxSize prevents huge \rule overlays; strict:"ignore" prevents warning floods for non-Latin text. Leave trust at its default false.
const backProcessor = unified().use(rehypeKatex, { maxSize: 10, strict: "ignore" }).use(rehypeStringify);

function toHtml(tree: HastNode): string {
  return String(backProcessor.stringify(backProcessor.runSync(tree as never) as never));
}

const defaultProcessors = new Map<string, ReturnType<typeof createFrontProcessor>>();

export type RenderOptions = {
  // Prefix for footnote id/href/aria-describedby. Vary per body when displaying multiple bodies on a page.
  idPrefix?: string;
  // Headings share anchors across languages; footnotes retain their version-specific prefix.
  // Without either prefix option, render headings without anchors for non-post pages.
  headingIdPrefix?: string;
  // Body language: a Paraglide locale, default English for absent/unknown values. Determines fixed footnote wording.
  lang?: string;
  // Typeset only machine-translated prose. Originals and human corrections keep their characters.
  translation?: boolean;
  // The saved mention bindings of the source revision. Without them, or empty, no member links are added. A translation gets the
  // targets of its source text, so that a handle that only the translation contains is not linked. Every call that renders a stored body passes them
  // (tests/mention-render-sites.test.ts); only checkRenderable, which just asks whether a body renders, does not.
  mentions?: MentionTargets;
};

function frontProcessorFor(opts: RenderOptions) {
  if (opts.headingIdPrefix === undefined && opts.idPrefix === undefined) {
    const key = JSON.stringify([opts.lang ?? "", opts.translation ?? false]);
    let cached = defaultProcessors.get(key);
    if (!cached) defaultProcessors.set(key, (cached = createFrontProcessor(DEFAULT_ID_PREFIX, opts.lang, undefined, opts.translation)));
    return cached;
  }
  return createFrontProcessor(opts.idPrefix ?? DEFAULT_ID_PREFIX, opts.lang, opts.headingIdPrefix ?? opts.idPrefix, opts.translation);
}

function renderTree(markdown: string, opts: RenderOptions): HastNode {
  const front = frontProcessorFor(opts);
  const file = { value: markdown, data: { mentionTargets: opts.mentions } };
  return front.runSync(front.parse(file), file);
}

// Deeply nested quotations/lists can throw RangeError from stack overflow.
export function renderMarkdown(markdown: string, opts: RenderOptions = {}): string {
  return toHtml(renderTree(markdown, opts));
}

// Rendered-output cap prevents repeated math in a short body from producing megabytes of HTML.
const MAX_RENDERED_LENGTH = 1_000_000;

// Return null on render exceptions or excessive output size.
export function tryRenderMarkdown(markdown: string, opts: RenderOptions = {}): string | null {
  try {
    const html = renderMarkdown(markdown, opts);
    return html.length > MAX_RENDERED_LENGTH ? null : html;
  } catch {
    return null;
  }
}

// Before accepting a post, reject bodies that throw during rendering or produce excessive output.
export function checkRenderable(markdown: string): boolean {
  return tryRenderMarkdown(markdown) !== null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Display helper: return escaped original text in pre if rendering fails, so one bad post cannot break the whole thread.
export function renderMarkdownOrPlain(markdown: string, opts: RenderOptions = {}): string {
  return tryRenderMarkdown(markdown, opts) ?? `<pre class="whitespace-pre-wrap">${escapeHtml(markdown)}</pre>`;
}

export { CARD_MAX_BLOCKS, CARD_MAX_CHARS };

// A rendered post: the full HTML and the card version (the beginning of a long body, cut on the server; app/lib/card-excerpt.server.ts). cardHtml is null when nothing was cut: the card
// then uses `html`. Both come from one render and are stored with the same html_version (entries.card_html, translations.card_html), so a change of either the rendering or the cut
// (a plugin, the sanitizing, CARD_MAX_CHARS, CARD_MAX_BLOCKS) means raising RENDER_VERSION.
export type RenderedEntry = { html: string; cardHtml: string | null; cardTruncated: boolean; cacheable?: boolean };

// The full HTML and the card version of a topic body (or of the translation of one). Throws when it cannot render (the same cases in which renderMarkdown throws, or an output over the limit).
// Replies have no card: they keep using renderMarkdown, renderMarkdownOrPlain and tryRenderMarkdown.
export function renderEntry(markdown: string, opts: RenderOptions = {}): RenderedEntry {
  const tree = renderTree(markdown, opts);
  // The card is cut from a copy of the tree before KaTeX touches it.
  const cardTree = buildCardTree(tree);
  const cardHtml = cardTree === null ? null : toHtml(cardTree);
  const html = toHtml(tree);
  if (html.length > MAX_RENDERED_LENGTH) throw new Error("rendered post is too large");
  return { html, cardHtml, cardTruncated: cardHtml !== null };
}

// null when the post cannot be rendered (an exception, or an output that is too large).
export function tryRenderEntry(markdown: string, opts: RenderOptions = {}): RenderedEntry | null {
  try {
    return renderEntry(markdown, opts);
  } catch {
    return null;
  }
}

// For display: a body that cannot be rendered is shown as its escaped source in a <pre> (the card version is the beginning of that).
export function renderEntryOrPlain(markdown: string, opts: RenderOptions = {}): RenderedEntry {
  const rendered = tryRenderEntry(markdown, opts);
  if (rendered) return rendered;
  const clipped = cardPlainText(markdown);
  return {
    html: `<pre class="whitespace-pre-wrap">${escapeHtml(markdown)}</pre>`,
    cardHtml: clipped === null ? null : `<pre class="whitespace-pre-wrap">${escapeHtml(clipped)}</pre>`,
    cardTruncated: clipped !== null,
  };
}
