import { createMarkdownProcessor } from "~/lib/markdown-parser.core.server";
import { siteUrl } from "~/lib/site-url";

type Node = { type: string; url?: string; identifier?: string; children?: Node[] };
export type ReferenceTarget = { topicId: number; entryId: number; kind: "topic" | "reply" };
const markdown = createMarkdownProcessor();
const idOf = (raw: string): number | null => /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;

function targetOf(raw: string, origin: string): ReferenceTarget | null {
  // Only root-relative links or explicit HTTP(S) URLs. Never resolve relative
  // paths or protocol-relative URLs against a request's Host header.
  if (!(raw.startsWith("/") && !raw.startsWith("//")) && !/^https?:\/\//i.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw, origin); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.origin !== origin || url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(raw)) return null;
  const match = /^\/t\/([1-9]\d*)(?:\.(?:md|txt))?$/.exec(url.pathname);
  const topicId = match ? idOf(match[1]) : null;
  if (topicId === null) return null;
  if (!url.hash) return { topicId, entryId: topicId, kind: "topic" };
  const anchor = /^#([pc])-([1-9]\d*)$/.exec(url.hash);
  const entryId = anchor ? idOf(anchor[2]) : null;
  if (!anchor || entryId === null || (anchor[1] === "p" && entryId !== topicId)) return null;
  return { topicId, entryId, kind: anchor[1] === "p" ? "topic" : "reply" };
}

// Parse syntax rather than matching URLs in raw text: quoted links, unused
// definitions, HTML, images and code never create a reference.
export function parseEntryReferences(body: string, base = siteUrl()): ReferenceTarget[] {
  const tree = markdown.parse(body) as Node;
  const definitions = new Map<string, string>();
  const collect = (node: Node) => {
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    node.children?.forEach(collect);
  };
  collect(tree);
  const found = new Map<string, ReferenceTarget>();
  const origin = new URL(base).origin;
  const visit = (node: Node) => {
    if (["blockquote", "code", "inlineCode", "math", "inlineMath", "html", "image", "imageReference", "definition"].includes(node.type)) return;
    const raw = node.type === "link" ? node.url : node.type === "linkReference" ? definitions.get(node.identifier ?? "") : undefined;
    if (raw) {
      const target = targetOf(raw, origin);
      if (target) found.set(`${target.topicId}:${target.entryId}:${target.kind}`, target);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return [...found.values()];
}
