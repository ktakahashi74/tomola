import { createMarkdownProcessor } from "~/lib/markdown-parser.core.server";
import path from "node:path";
import { defaultSchema } from "rehype-sanitize";
import type { Lang } from "~/lib/languages";
import { mediaImage } from "~/lib/markdown.core.server";
import { MEDIA_LIMITS } from "~/lib/media";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function unescapeAttribute(text: string): string {
  return text.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

export type ExportLinks = {
  page: string;
  lang: Lang;
  extension: "html" | "md";
  // Only public posts are link targets. Placeholder replies deliberately are not.
  posts: ReadonlyMap<number, number>;
  documents: ReadonlySet<string>;
  origin?: string;
  media?: ReadonlyMap<string, string>;
};

function exportedImage(href: string, links: ExportLinks): string | null {
  const image = mediaImage(href, links.origin ?? "https://export.invalid");
  const file = image && links.media?.get(image.id);
  return file ? relativeFile(links.page, file) : null;
}

export function relativeFile(from: string, to: string): string {
  return path.posix.relative(path.posix.dirname(from), to) || path.posix.basename(to);
}

export function exportHref(href: string, links: ExportLinks): string | null {
  if (href.startsWith("#")) return href;
  let url: URL;
  const origin = links.origin ?? "https://export.invalid";
  try { url = new URL(href, origin); } catch { return null; }
  if (url.origin !== new URL(origin).origin) return defaultSchema.protocols?.href?.includes(url.protocol.slice(0, -1)) ? href : null;
  const image = exportedImage(href, links);
  if (image) return image;
  const match = /^\/t\/([1-9]\d*)(?:\.md)?\/?$/.exec(url.pathname);
  if (match) {
    const thread = links.posts.get(Number(match[1]));
    if (thread === undefined) return null;
    const comment = /^#c-([1-9]\d*)$/.exec(url.hash);
    if (comment && links.posts.get(Number(comment[1])) !== thread) return null;
    const hash = comment ? url.hash : Number(match[1]) !== thread ? `#c-${match[1]}` : "";
    return relativeFile(links.page, `${links.lang}/t/${thread}.${links.extension}`) + hash;
  }
  const document = /^\/(principles|why|name)(?:\.md)?\/?$/.exec(url.pathname)?.[1];
  if (document && links.documents.has(`${links.lang}/${document}`)) {
    return relativeFile(links.page, `${links.lang}/${document}.${links.extension}`) + url.hash;
  }
  // Member links and application-only routes have no offline counterpart.
  return null;
}

// rehype-stringify quotes attribute values, but allows literal angle brackets in
// them. One tokenizer serves inspection, images, and both ends of links, so an
// apparent closing tag inside a descendant's title is never treated as markup.
const HTML_TAG = /<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
const HTML_ATTRIBUTE = /\s+([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
function readTag(raw: string) {
  const tag = /^<(\/?)([\w:-]+)/.exec(raw);
  if (!tag) return null; // A comment has no elements or attributes.
  const attributes = [...raw.matchAll(HTML_ATTRIBUTE)].map(match => ({
    name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4],
    start: match.index!, end: match.index! + match[0].length,
  }));
  return { name: tag[2].toLowerCase(), closing: tag[1] === "/", attributes };
}
function inspectTags(html: string) {
  const counts = new Map<string, number>();
  for (const match of html.matchAll(HTML_TAG)) {
    const tag = readTag(match[0]);
    if (!tag) continue;
    const key = `${tag.closing ? "/" : ""}${tag.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (/^(?:script|style|link|iframe|object|embed|video|audio|source|base|meta|form)$/.test(tag.name)
      || tag.attributes.some(attr => /^(?:on[a-z]+|srcdoc|xlink:href)$/.test(attr.name)
        || (attr.name === "style" && /url\s*\(|@import/i.test(unescapeAttribute(attr.value ?? ""))))) {
      throw new Error("Saved render contains active content or resource loading");
    }
  }
  return counts;
}

// Input is the app's saved sanitized HTML, or its existing renderer's output.
// Never feed raw user HTML here. KaTeX's SVG and safe inline styles stay intact.
export function offlineHtml(html: string, links: ExportLinks): string {
  const allowed = inspectTags(html);
  const remove = (name: string) => {
    allowed.set(name, (allowed.get(name) ?? 0) - 1);
    return "";
  };
  const anchors: boolean[] = [];
  const output = html.replace(HTML_TAG, raw => {
    const tag = readTag(raw);
    if (!tag) return raw;
    if (tag.name === "img" && !tag.closing) {
      const src = tag.attributes.find(attr => attr.name === "src");
      const target = src?.value && exportedImage(unescapeAttribute(src.value), links);
      if (target && src) {
        const image = mediaImage(unescapeAttribute(src.value!), links.origin ?? "https://export.invalid")!;
        const alt = unescapeAttribute(tag.attributes.find(attr => attr.name === "alt")?.value ?? "");
        return `<img src="${escapeHtml(target)}" alt="${escapeHtml(alt)}" width="${image.width}" height="${image.height}" loading="lazy" decoding="async">`;
      }
      const value = tag.attributes.find(attr => attr.name === "alt")?.value
        ?? tag.attributes.find(attr => attr.name === "src")?.value ?? "";
      // Move an attribute value to text only after decoding and escaping it.
      remove("img");
      return escapeHtml(unescapeAttribute(value));
    }
    if (tag.name !== "a") return raw;
    if (tag.closing) return (anchors.pop() ?? true) ? raw : remove("/a");
    const href = tag.attributes.find(attr => attr.name === "href");
    const target = href?.value === undefined ? undefined : exportHref(unescapeAttribute(href.value), links);
    anchors.push(target !== null);
    if (target === null) return remove("a");
    if (!href || target === undefined) return raw;
    // Replace the actual href attribute, retaining footnote ids and ARIA values.
    return raw.slice(0, href.start) + ` href="${escapeHtml(target)}"` + raw.slice(href.end);
  });
  for (const [name, count] of inspectTags(output)) {
    if (count > (allowed.get(name) ?? 0)) throw new Error("Offline rewriting introduced an HTML element");
  }
  const images = new Set([...(links.media?.values() ?? [])].map(file => relativeFile(links.page, file)));
  for (const match of output.matchAll(HTML_TAG)) {
    const tag = readTag(match[0]);
    if (tag?.name === "img" && !tag.closing && !images.has(unescapeAttribute(tag.attributes.find(attr => attr.name === "src")?.value ?? ""))) {
      throw new Error("Offline image is not an exported asset");
    }
  }
  return output;
}

type MdNode = {
  type: string; url?: string; identifier?: string; alt?: string; value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

// Text that the export itself puts in a link label (an image's alternative text, a bare URL) is escaped,
// so that it is still text when the output is read as Markdown again. A line break would let a later line start a block.
const labelText = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/[\\`*_[\]<>&!~$|]/g, "\\$&");
// A destination in angle brackets ends at ">", cannot hold "<", and reads backslashes and "&" as escapes.
const destination = (url: string) => `<${url.replace(/[\\<>&]/g, "\\$&")}>`;

type Edit = { start: number; end: number; text: string };
const parseMarkdown = (markdown: string) => createMarkdownProcessor().parse(markdown) as MdNode;
export function referencedMedia(markdown: string, origin?: string): string[] {
  const tree = parseMarkdown(markdown), definitions = new Map<string, string>(), ids = new Set<string>();
  const definitionsOf = (node: MdNode): void => {
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node.url);
    node.children?.forEach(definitionsOf);
  };
  definitionsOf(tree);
  const visit = (node: MdNode): void => {
    if (node.type === "image" || node.type === "imageReference") {
      const image = mediaImage(node.url ?? definitions.get(node.identifier?.toUpperCase() ?? "") ?? "", origin ?? "https://export.invalid");
      if (image) ids.add(image.id);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return [...ids];
}
const range = (node: MdNode) => ({ start: node.position?.start.offset, end: node.position?.end.offset });
// Applies edits to the source between two offsets. "!" just before a link that an edit writes would turn it into an image.
function applyEdits(markdown: string, edits: Edit[], from: number, to: number): string {
  let output = "", cursor = from;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    output += markdown.slice(cursor, edit.start);
    if (edit.text.startsWith("[") && /(?:^|[^\\])(?:\\\\)*!$/.test(output)) output = `${output.slice(0, -1)}\\!`;
    output += edit.text;
    cursor = edit.end;
  }
  return output + markdown.slice(cursor, to);
}

// Rewrite links using Markdown source positions, preserving prose, code and math.
// Code or math that happens to look like a link is untouched. Raw HTML is omitted as in
// the app renderer. Reference links are resolved before removing definitions.
// The source is read with the grammar of the app renderer (GFM and math), and the result is meant to be read
// with the same grammar: what stands between two "$" is math there, and stays as written even if it looks like an image.
export function offlineMarkdown(markdown: string, links: ExportLinks): string {
  // The parser drops a leading byte order mark and counts positions without it.
  if (markdown.charCodeAt(0) === 0xfeff) markdown = markdown.slice(1);
  const tree = parseMarkdown(markdown);
  const definitions = new Map<string, string>();
  const collect = (node: MdNode): void => {
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node.url);
    node.children?.forEach(collect);
  };
  collect(tree);
  // Every link target that is meant to be in the result. A line break would end a destination.
  const targets = new Set<string>();
  const imageTargets = new Set<string>();
  let images = 0;
  const link = (label: string, target: string) => {
    const url = target.replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    targets.add(url);
    return `[${label}](${destination(url)})`;
  };
  // Rewrites the source between two offsets from the nodes already parsed. A label is never parsed again:
  // a bare URL is a link whose label is the same URL, so parsing the label would find that link without end.
  // Inside a label, a nested image or link leaves only its own label, because a link cannot hold another link.
  const rewrite = (nodes: MdNode[], from: number, to: number, inLabel: boolean): string => {
    const edits: Edit[] = [];
    const visit = (node: MdNode): void => {
      const { start, end } = range(node);
      if (start === undefined || end === undefined) return;
      if (node.type === "html" || node.type === "definition") {
        edits.push({ start, end, text: "" });
        return;
      }
      if (["link", "linkReference", "image", "imageReference"].includes(node.type)) {
        const href = node.url ?? definitions.get(node.identifier?.toUpperCase() ?? "");
        const target = href === undefined || inLabel ? null : exportHref(href, links);
        const children = node.children ?? [];
        // A bare URL or <URL>: the source has no label to copy, only the URL itself. It stays as written unless it
        // points to an exported file. Only a <URL> with a scheme that links must not use is reduced to its text
        // (an http or https URL would be read as a link again without the brackets, so it keeps them).
        if (node.type === "link" && markdown[start] !== "[") {
          if (target === href || (target === null && /^https?:/i.test(href ?? ""))) {
            if (href !== undefined) targets.add(href);
            return;
          }
          const text = labelText(children.map(child => child.value ?? "").join(""));
          edits.push({ start, end, text: target === null ? text : link(text, target) });
          return;
        }
        const first = children.length ? range(children[0]).start : undefined;
        const last = children.length ? range(children[children.length - 1]).end : undefined;
        const label = first !== undefined && last !== undefined ? rewrite(children, first, last, true) : labelText(node.alt ?? "");
        const imageTarget = !inLabel && href && (node.type === "image" || node.type === "imageReference") ? exportedImage(href, links) : null;
        if (imageTarget && images++ < MEDIA_LIMITS.perPost) {
          imageTargets.add(imageTarget);
          edits.push({ start, end, text: `![${label}](${destination(imageTarget)})` });
        } else edits.push({ start, end, text: target === null ? label : link(label, target) });
        return;
      }
      node.children?.forEach(visit);
    };
    nodes.forEach(visit);
    return applyEdits(markdown, edits, from, to);
  };
  return withoutLeftovers(rewrite([tree], 0, markdown.length, false), targets, imageTargets);
}

// Edits are made in place, so the text on both sides of an edit can join into markup that neither side was
// (a tag from the halves around a removed tag, an image from a bare URL that stops being one, a link from brackets
// around a dropped link). Read the result again and reduce to its text any image, raw HTML or definition, and any
// link whose target is not one of `targets`, until none is left. A bare http or https URL shows its own target and stays.
function withoutLeftovers(markdown: string, targets: ReadonlySet<string>, imageTargets: ReadonlySet<string>): string {
  for (let pass = 0; pass < 8; pass++) {
    const edits: Edit[] = [];
    const visit = (node: MdNode): void => {
      const { start, end } = range(node);
      if (start === undefined || end === undefined) return;
      if (node.type === "html" || node.type === "definition") edits.push({ start, end, text: "" });
      else if ((node.type === "image" && !imageTargets.has(node.url ?? "")) || node.type === "imageReference") edits.push({ start, end, text: labelText(node.alt ?? "") });
      else if (node.type === "linkReference" || (node.type === "link" && !targets.has(node.url ?? "") && (markdown[start] === "[" || !/^https?:/i.test(node.url ?? "")))) {
        const children = node.children ?? [];
        const first = children.length ? range(children[0]).start : undefined;
        const last = children.length ? range(children[children.length - 1]).end : undefined;
        const label = markdown[start] !== "[" ? labelText(children.map(child => child.value ?? "").join(""))
          : first !== undefined && last !== undefined ? markdown.slice(first, last) : "";
        edits.push({ start, end, text: label });
      } else node.children?.forEach(visit);
    };
    visit(parseMarkdown(markdown));
    if (edits.length === 0) return markdown;
    markdown = applyEdits(markdown, edits, 0, markdown.length);
  }
  // Still not settled: nothing can start a tag, an image, a link or a definition once these are all escaped.
  return markdown.replace(/[\\<!\[]/g, "\\$&");
}

export const EXPORT_CSS = `:root{color-scheme:light}body{max-width:76ch;margin:2rem auto;padding:0 1rem;color:#202020;background:#fff;font:18px/1.75 system-ui,sans-serif}a{color:#174b92;overflow-wrap:anywhere}nav{display:flex;flex-wrap:wrap;gap:1rem}h1,h2,h3{line-height:1.35}article{margin:2rem 0;padding:1rem 0;border-top:1px solid #bbb}.meta,.status{font-size:.9rem;color:#555}.placeholder{border:1px dashed #aaa;padding:1rem}pre{overflow:auto;white-space:pre-wrap;background:#f4f4f4;padding:1rem}code{font-size:.9em}blockquote{border-left:3px solid #bbb;margin-left:0;padding-left:1rem}table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #aaa;padding:.4rem}img{max-width:100%;height:auto}.katex-display{overflow:auto;padding:.3rem 0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:600px){body{font-size:16px;margin:1rem auto}}`;
