import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every call that renders a stored body passes its mention bindings: a call that forgets them loses the saved member links, and the stored rendering would not match
// the one the post was made with. A new call that does not pass it fails here. checkRenderable only asks whether a body renders and is not scanned; the definitions are skipped.
const RENDER_CALLS = ["renderMarkdown", "tryRenderMarkdown", "renderMarkdownOrPlain", "renderEntry", "renderEntryOrPlain", "renderEntryHtml"];

// Files that render a document written by the site (not a post of a member): there is no member to name in it, so a mention is not looked up.
const SITE_DOCUMENTS: Record<string, { reason: string; arguments?: RegExp }> = {
  "app/lib/notices.server.ts": { reason: "privacy and participation notices: site documents without member mention bindings" },
  "app/lib/principles.server.ts": { reason: "the principles page: a document of the site, rendered once per language" },
  "app/lib/signed-document.server.ts": { reason: "signed site documents, rendered once per language without member mention bindings" },
  "app/lib/site-export.server.ts": { reason: "only the site's principles and signed documents; exported member posts still require saved mention bindings", arguments: /^doc\.markdown\s*,/ },
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "paraglide" || e.name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

// The text between the parentheses of a call that starts at `open` (the index of "(").
function argumentsAt(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

describe("the call sites of the Markdown renderer", () => {
  const root = path.resolve(__dirname, "..");
  const files = [...sourceFiles(path.join(root, "app")), ...sourceFiles(path.join(root, "scripts"))];
  const pattern = new RegExp(`\\b(${RENDER_CALLS.join("|")})\\s*\\(`, "g");

  it("every call passes mentions", () => {
    const missing: string[] = [];
    let found = 0;
    for (const file of files) {
      // Comments are not code: a call that is named in a comment is not a call.
      const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/(^|[^:])\/\/.*$/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
      for (const match of code.matchAll(pattern)) {
        const before = code.slice(Math.max(0, match.index! - 20), match.index!);
        // The definition (`function renderMarkdown(`), and a method of an object type are not calls.
        if (/function\s+$/.test(before) || /export\s+const\s+$/.test(before)) continue;
        // markdown.server.ts: renderMarkdown delegates with the options it was given.
        if (file.endsWith(path.join("app", "lib", "markdown.server.ts")) || file.endsWith(path.join("app", "lib", "markdown.core.server.ts"))) continue;
        const args = argumentsAt(code, match.index! + match[0].length - 1);
        const document = SITE_DOCUMENTS[path.relative(root, file)];
        if (document && (!document.arguments || document.arguments.test(args.trim()))) continue;
        found++;
        if (!/\bmentions\b/.test(args)) missing.push(`${path.relative(root, file)}: ${match[1]}(${args.replace(/\s+/g, " ").slice(0, 80)}…)`);
      }
    }
    // The scan finds the calls (it is not passing because it found none).
    expect(found).toBeGreaterThanOrEqual(8);
    expect(missing).toEqual([]);
  });
});
