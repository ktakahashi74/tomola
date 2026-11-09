import { Scalar, stringify } from "yaml";

// Markdown frontmatter/body handling. Member/LLM-written bodies, titles, handles and translations are untrusted data.
// Several posts share one file, so enforce:
// - Generate frontmatter with the real YAML serializer (yaml package), keeping newlines/quotes/`---` inside values
//   by always double-quoting untrusted strings, without wrapping or block scalars.
// - Rewrite body/translation lines containing only `---` or `...` so they cannot resemble another post's frontmatter delimiters (neutralizeBody).

export type FmValue = string | number | boolean | null | FmValue[] | { [key: string]: FmValue | undefined };

// Safe unquoted strings begin with a letter and contain only alphanumeric characters and _ . / : - (ids, language tags, URLs, enums).
// Quote YAML 1.1 boolean words y,n,yes,no,on,off because parsers such as PyYAML interpret them as booleans.
const PLAIN = /^[A-Za-z][A-Za-z0-9_./:-]*$/;
const YAML_WORD = /^(?:y|n|yes|no|on|off|true|false|null)$/i;

// Exclude YAML string characters that may act as line separators (NEL,LS,PS), C1 controls, DEL, BOM and direction controls.
// yaml emits them literally even inside double quotes, so replace with U+FFFD first.
// The yaml package escapes C0 controls as \x01, with newlines/tabs as \n/\t.
const REPLACEMENT = String.fromCodePoint(0xfffd);
// Unpaired surrogate: invalid UTF-16.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const UNSAFE = /[\u007f-\u009f\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu;

function scalar(value: string): Scalar | string {
  const clean = value.replace(LONE_SURROGATE, REPLACEMENT).replace(UNSAFE, REPLACEMENT);
  if (PLAIN.test(clean) && !YAML_WORD.test(clean)) return clean;
  const node = new Scalar(clean);
  node.type = "QUOTE_DOUBLE";
  return node;
}

function toNode(value: FmValue | undefined): unknown {
  if (typeof value === "string") return scalar(value);
  if (Array.isArray(value)) return value.map(toNode);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = toNode(v);
    return out;
  }
  return value;
}

// Line separators recognized by Unicode or Python str.splitlines. Frontmatter may contain only \n.
const OTHER_BREAKS = "\\r\\v\\f\\x1c-\\x1e\\u0085\\u2028\\u2029";
const LINE_BREAKS = `\\n${OTHER_BREAKS}`;
const BREAK_CHAR = new RegExp(`[${OTHER_BREAKS}]`, "u");
// Trailing non-line-separator whitespace: \s (NBSP, full-width spaces, U+2000–U+200A, etc.) plus U+001F, which Python includes in \s.
// After `---`, these still look like delimiters to whitespace-tolerant boundary regexes such as python-frontmatter's.
const TRAILING_SPACE = `(?:(?![${LINE_BREAKS}])[\\s\\x1f])*`;
// Delimiter-like lines: at least three hyphens or `...`, optionally followed by whitespace.
const BOUNDARY_LINE = new RegExp(`^(?:-{3,}|\\.\\.\\.)${TRAILING_SPACE}$`, "u");

// Assert values cannot escape the frame; reaching this indicates a producer bug.
function assertFramed(text: string, what: string): void {
  if (BREAK_CHAR.test(text)) throw new Error(`${what} contains a raw line break character`);
  for (const line of text.split("\n")) if (BOUNDARY_LINE.test(line)) throw new Error(`${what} contains a boundary line`);
}

// Frontmatter YAML without `---` delimiters. Fixed key names; only values are untrusted.
export function frontmatterYaml(fields: { [key: string]: FmValue | undefined }): string {
  const text = stringify(toNode(fields), { lineWidth: 0, blockQuote: false, indent: 2 });
  assertFramed(text, "frontmatter");
  return text;
}

// Delimited frontmatter block (---). preamble is one YAML comment line (「# …」) placed first inside the frame of the file's first block,
// a fixed caution for the reading AI, ignored by YAML.
export type BlockOptions = { preamble?: string };

export function frontmatterBlock(fields: { [key: string]: FmValue | undefined }, opts: BlockOptions = {}): string {
  let comment = "";
  if (opts.preamble !== undefined) {
    if (!opts.preamble.startsWith("# ") || opts.preamble.includes("\n")) throw new Error("preamble must be a single YAML comment line");
    assertFramed(opts.preamble, "preamble");
    comment = `${opts.preamble}\n`;
  }
  return `---\n${comment}${frontmatterYaml(fields)}---\n`;
}

// Emit bodies/translations without delimiter-like lines. Rewrite whole lines of `---` (three or more hyphens, optional trailing whitespace) as `- - -`
// (the same horizontal rule), and `...` alone as `\.\.\.` (same visible text). Line separators include newline and other characters
// recognized by parsers, such as \r,\v,\f,NEL,LS,PS. Treat all trailing \s characters as whitespace too.
// Rewrite even inside code blocks, prioritizing prevention of delimiter confusion.
// Strip trailing whitespace/newlines; callers separate the next block with a blank line.
const BOUNDARY_IN_TEXT = new RegExp(`(^|[${LINE_BREAKS}])(-{3,}|\\.\\.\\.)(${TRAILING_SPACE})(?=$|[${LINE_BREAKS}])`, "gu");
export function neutralizeBody(text: string): string {
  return text
    .replace(BOUNDARY_IN_TEXT, (_m, before: string, marks: string, trailing: string) => `${before}${marks.startsWith("-") ? "- - -" : "\\.\\.\\."}${trailing}`)
    .trimEnd();
}

// Combine frontmatter and body as one block. Separate multiple blocks by blank lines.
export function mdBlock(fields: { [key: string]: FmValue | undefined }, body: string | null, opts: BlockOptions = {}): string {
  return frontmatterBlock(fields, opts) + (body === null || body === "" ? "" : `${neutralizeBody(body)}\n`);
}

export function joinBlocks(blocks: readonly string[]): string {
  return blocks.join("\n");
}

// List items as a YAML array of maps, also readable as Markdown bullets. Follow frontmatter serialization rules.
export function yamlList(items: readonly { [key: string]: FmValue | undefined }[]): string {
  const text = stringify(toNode([...items]), { lineWidth: 0, blockQuote: false, indent: 2 });
  assertFramed(text, "list");
  return text;
}
