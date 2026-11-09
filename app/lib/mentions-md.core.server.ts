import { createMarkdownProcessor } from "~/lib/markdown-parser.core.server";
import { handleKey } from "~/lib/handles";
import { mentionCandidates, tokenPrefixes } from "~/lib/mention-syntax";
import { selectMentionRecipients } from "~/lib/mention-notifications";
import { draftExcerpt, MAX_DRAFT_ISSUES, type DraftIssue } from "~/lib/draft-issues";

// Mentions on the Markdown syntax tree. No database here: the members a mention can name come in as `targets`.
//
// Where a mention counts: in the text nodes of the tree. Not in code (fenced, indented, inline), math, raw HTML, link text and link targets (this includes the automatic links of
// GFM: URLs and e-mail addresses), images, definitions. Headings, tables, footnotes, emphasis and lists count. A mention inside a block quote is shown as a mention but is not
// a call: whoever writes a quote copies somebody else's words, so it does not notify (`quoted`). An escaped sigil (\@hana) is not a mention.
// Rendering (remarkMentions), the notification list (matchMentions) and the translation check read the body through the same walk, so they cannot disagree.

// Ordinary targets use handle_key (NFKC and lower case). Saved bindings use an exact, sigil-inclusive spelling key, and retain the matched prefix or an unresolved null.
export type MentionTarget = { handle: string; userId: string; publicId?: string; prefix?: string | null };
export type MentionTargets = ReadonlyMap<string, MentionTarget>;

export type MentionMatch = { text: string; handle: string; userId: string; key: string; publicId?: string };
export type MentionPiece = string | MentionMatch;

export const frozenMentionKey = (spelling: string): string => `\0${spelling}`;

// Limits of what one body can ask the database about (a body is at most 50,000 characters, so this is a ceiling, not a typical size).
export const MAX_MENTION_CANDIDATES = 50;

const markdown = createMarkdownProcessor();

type MdNode = {
  type: string;
  value?: string;
  position?: { start: { offset?: number; line?: number }; end: { offset?: number } };
  children?: MdNode[];
  data?: object;
};

// Nodes whose text is not a place for a mention (their children are not visited). Code, math, HTML, images and definitions have no text children, so they need no entry.
const SKIPPED_CONTAINERS = new Set(["link", "linkReference"]);

// The indexes of the characters of a text node's value that the author wrote as an escape or a character reference (\@, &#64;): the value has the character, the source has more.
// Markdown itself decodes references, including invalid numeric references and named references with several code points. Reuse that decoding instead of guessing their length.
function decodeReference(reference: string): string | null {
  const tree = markdown.parse(reference);
  const paragraph = tree.children[0];
  if (paragraph?.type !== "paragraph" || paragraph.children.length !== 1) return null;
  const text = paragraph.children[0];
  return text.type === "text" ? text.value : null;
}

// Container indentation and quote markers can be absent from a multiline text node's value. Skip those only at line starts. If alignment is unknown, suppress the remaining
// sigils: guessing that the rest was plain text could notify an escaped mention.
function escapedIndexes(value: string, source: string, quoted: boolean): Set<number> {
  const out = new Set<number>();
  if (value === source) return out;
  let i = 0;
  let j = 0;
  let lineStart = false;
  while (i < value.length && j < source.length) {
    // A decoded ampersand also starts with '&'; consume the entire reference before trying a one-character match.
    if (source[j] === "&") {
      const ref = /^&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/.exec(source.slice(j));
      const decoded = ref ? decodeReference(ref[0]) : null;
      if (ref && decoded !== null && decoded !== ref[0]) {
        if (!value.startsWith(decoded, i)) break;
        for (let k = 0; k < decoded.length; k++) out.add(i + k);
        i += decoded.length;
        j += ref[0].length;
        lineStart = false;
        continue;
      }
    }
    if (source[j] === "\\" && j + 1 < source.length && source[j + 1] === value[i] && /[!-/:-@[-`{-~]/.test(value[i])) {
      out.add(i);
      i++;
      j += 2;
    } else if (source[j] === value[i]) {
      lineStart = value[i] === "\n" || (lineStart && /[ \t]/.test(value[i]));
      i++;
      j++;
    } else if (lineStart && (/[ \t]/.test(source[j]) || (quoted && source[j] === ">"))) {
      j++;
    } else {
      break;
    }
  }
  // A candidate that began earlier can still cross into the unknown part (for example, its handle was only partly aligned).
  if (i < value.length) for (const candidate of mentionCandidates(value)) if (candidate.end > i) out.add(candidate.start);
  for (; i < value.length; i++) out.add(i);
  return out;
}

type TextSite = { node: MdNode; parent: MdNode; quoted: boolean; escaped: Set<number> };

// The text nodes where a mention counts, in document order, with the node that holds each one. `quoted`: inside a block quote. Collected first and visited afterwards, so that the
// plugin can change the tree without the walk meeting its own new nodes.
function textSites(root: MdNode, source: string): TextSite[] {
  const out: TextSite[] = [];
  const walk = (node: MdNode, quoted: boolean): void => {
    const children = node.children;
    if (!children) return;
    const inQuote = quoted || node.type === "blockquote";
    for (const child of children) {
      if (child.type === "text") {
        const value = child.value ?? "";
        if (value.includes("@") || value.includes("＠")) {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const raw = start !== undefined && end !== undefined ? source.slice(start, end) : null;
          out.push({ node: child, parent: node, quoted: inQuote, escaped: raw === null ? new Set(mentionCandidates(value).map((c) => c.start)) : escapedIndexes(value, raw, inQuote) });
        }
      } else if (!SKIPPED_CONTAINERS.has(child.type)) {
        walk(child, inQuote);
      }
    }
  };
  walk(root, false);
  return out;
}

const normalizeNewlines = (text: string) => text.replace(/\r\n/g, "\n");

function parse(text: string): { tree: MdNode; source: string } {
  const source = normalizeNewlines(text);
  return { tree: markdown.parse(source), source };
}

// The candidates of a text node that are not escaped.
function candidatesOf(value: string, escaped: ReadonlySet<number>) {
  return mentionCandidates(value).filter((c) => !escaped.has(c.start));
}

// The runs of handle characters that follow a sigil in the body (without repeats, in order of appearance, at most MAX_MENTION_CANDIDATES), ready to be looked up
// (tokenPrefixes). Nothing here knows a member.
export function mentionTokens(markdownText: string): string[] {
  if (!markdownText.includes("@") && !markdownText.includes("＠")) return [];
  const { tree, source } = parse(markdownText);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { node, escaped } of textSites(tree, source)) {
    for (const c of candidatesOf(node.value ?? "", escaped)) {
      if (out.length >= MAX_MENTION_CANDIDATES) return out;
      const key = handleKey(c.token);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c.token);
    }
  }
  return out;
}

// Every exact candidate spelling must be saved, including those beyond the bounded live lookup. Otherwise a later render could resolve an originally unknown spelling.
export function mentionSpellings(markdownText: string): string[] {
  if (!markdownText.includes("@") && !markdownText.includes("＠")) return [];
  const { tree, source } = parse(markdownText);
  const out = new Set<string>();
  for (const { node, escaped } of textSites(tree, source)) {
    const value = node.value ?? "";
    for (const c of candidatesOf(value, escaped)) out.add(value.slice(c.start, c.end));
  }
  return [...out];
}

// The longest prefix of the run that is the handle of a member, with the member. null: the run names nobody.
function longestMatch(token: string, targets: MentionTargets): { prefix: string; target: MentionTarget; key: string } | null {
  for (const prefix of tokenPrefixes(token)) {
    const key = handleKey(prefix);
    const target = targets.get(key);
    if (target) return { prefix, target, key };
  }
  return null;
}

// A text node's value cut into plain text and mentions (the characters of the source, sigil included, are kept as they are). The candidates that name no member are plain text.
export function splitMentions(value: string, targets: MentionTargets, escaped: ReadonlySet<number> = new Set()): MentionPiece[] {
  if (targets.size === 0 || (!value.includes("@") && !value.includes("＠"))) return [value];
  const out: MentionPiece[] = [];
  let at = 0;
  for (const c of candidatesOf(value, escaped)) {
    const frozenKey = frozenMentionKey(value.slice(c.start, c.end));
    let found: ReturnType<typeof longestMatch>;
    if (targets.has(frozenKey)) {
      const target = targets.get(frozenKey)!;
      const prefix = target.prefix;
      // An unresolved binding forbids fallback to current names. Reject malformed saved prefixes rather than linking beyond the original candidate.
      if (!prefix || !target.userId || prefix.length > c.token.length || handleKey(c.token.slice(0, prefix.length)) !== handleKey(prefix)) continue;
      found = { prefix, target, key: handleKey(prefix) };
    } else {
      found = longestMatch(c.token, targets);
    }
    if (!found) continue;
    const end = c.start + 1 + found.prefix.length;
    if (c.start > at) out.push(value.slice(at, c.start));
    out.push({ text: value.slice(c.start, end), handle: found.target.handle, userId: found.target.userId, key: found.key, ...(found.target.publicId !== undefined ? { publicId: found.target.publicId } : {}) });
    at = end;
  }
  if (at < value.length) out.push(value.slice(at));
  return out.length === 0 ? [value] : out;
}

// The mentions of a body, in order of appearance, once per normalized prefix and member. `text` is the first occurrence as written (sigil included). `quoted`: the member appears only inside block
// quotes (a member who also appears outside a quote is not quoted).
export function matchMentions(markdownText: string, targets: MentionTargets): Array<MentionMatch & { quoted: boolean }> {
  if (targets.size === 0 || (!markdownText.includes("@") && !markdownText.includes("＠"))) return [];
  const { tree, source } = parse(markdownText);
  const byKey = new Map<string, MentionMatch & { quoted: boolean }>();
  for (const { node, quoted, escaped } of textSites(tree, source)) {
    for (const piece of splitMentions(node.value ?? "", targets, escaped)) {
      if (typeof piece === "string") continue;
      const memberKey = JSON.stringify([piece.key, piece.userId]);
      const known = byKey.get(memberKey);
      if (known) {
        // Seen outside a quote at least once: not quoted.
        if (!quoted) known.quoted = false;
      } else {
        byKey.set(memberKey, { ...piece, quoted });
      }
    }
  }
  return [...byKey.values()];
}

// Read the very same text sites and resolutions used for rendering and notifications.
export function draftMentionIssues(markdownText: string, targets: MentionTargets, authorId: string): DraftIssue[] {
  if (!/[@＠]/.test(markdownText)) return [];
  const matches = matchMentions(markdownText, targets).filter(match => !match.quoted);
  const notified = new Set(selectMentionRecipients(matches.map(match => match.userId), authorId));
  const { tree, source } = parse(markdownText);
  const out: DraftIssue[] = [];
  for (const { node, quoted, escaped } of textSites(tree, source)) {
    if (quoted) continue;
    const value = node.value ?? "";
    for (const candidate of candidatesOf(value, escaped)) {
      const spelling = value.slice(candidate.start, candidate.end);
      const match = splitMentions(spelling, targets).find(piece => typeof piece !== "string");
      if (match && (match.userId === authorId || notified.has(match.userId))) continue;
      out.push({ kind: "unknown_mention", location: { field: "body", line: (node.position?.start.line ?? 1) + value.slice(0, candidate.start).split("\n").length - 1 },
        excerpt: draftExcerpt(spelling), message: "This mention will not notify a member. Check the handle and the per-post mention limit if a notification is intended." });
      if (out.length > MAX_DRAFT_ISSUES) return out;
    }
  }
  return out;
}

// The members that a source text really names (the mentions of matchMentions, quoted ones included: they are shown as mentions), as targets for rendering a translation of it.
// A translation is rendered with these only, so a handle that the translation has and the source does not (a translation must not make a mention) is not emphasized.
export function sourceTargets(source: string, all: MentionTargets): MentionTargets {
  // Saved maps include unresolved bindings, which must survive translation rendering. Any safe normalized aliases have already been decided by the persistence layer.
  if ([...all.keys()].some((key) => key.startsWith("\0"))) return all;
  return new Map(matchMentions(source, all).map((m) => [m.key, { handle: m.handle, userId: m.userId, ...(m.publicId !== undefined ? { publicId: m.publicId } : {}) }]));
}

// Links use the member's immutable public ID and preserve the source text. A target without a public ID remains ordinary text.
export function remarkMentions() {
  return (tree: MdNode, file: { data: object }): void => {
    const targets = (file.data as { mentionTargets?: MentionTargets }).mentionTargets;
    if (!targets || targets.size === 0) return;
    // The raw text of the source is needed to find escaped sigils: the tree was parsed from the file's value.
    const value = (file as { value?: unknown }).value;
    const source = typeof value === "string" ? value : "";
    // Last text node first: the nodes before it keep their index in the parent while this one is replaced.
    for (const { node, parent, escaped } of textSites(tree, source).reverse()) {
      const pieces = splitMentions(node.value ?? "", targets, escaped);
      if (pieces.length === 1 && typeof pieces[0] === "string") continue;
      const nodes: MdNode[] = pieces.map((piece) =>
        typeof piece === "string" || !piece.publicId
          ? { type: "text", value: typeof piece === "string" ? piece : piece.text }
          : { type: "mention", data: { hName: "a", hProperties: { className: ["mention"], href: `/u/id/${piece.publicId}` } }, children: [{ type: "text", value: piece.text }] },
      );
      parent.children!.splice(parent.children!.indexOf(node), 1, ...nodes);
    }
  };
}
