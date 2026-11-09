import * as markdown from "../app/lib/markdown.core.server.ts";
import * as mentions from "../app/lib/mentions-md.core.server.ts";
import * as plainText from "../app/lib/plain-text.core.server.ts";
import * as references from "../app/lib/entry-references.core.server.ts";
import * as siteExport from "../app/lib/site-export-format.core.server.ts";
import * as structure from "../app/lib/llm/structure.core.server.ts";
import * as copyDetection from "../app/lib/llm/copy-detection.core.server.ts";
import * as langDetect from "../app/lib/lang-detect.core.server.ts";
import * as headline from "../app/lib/headline.core.server.ts";
import * as inspection from "../app/lib/llm/translation-inspect.core.server.ts";
import * as frontmatter from "../app/lib/entry-frontmatter.core.server.ts";
import * as draftIssues from "../app/lib/draft-issues.core.server.ts";
import * as checks from "../app/lib/eval/checks.core.server.ts";
import { markdownSpecimen } from "../app/lib/markdown-specimen.ts";
import { withoutMarkdownParseCache } from "../app/lib/markdown-parser.core.server.ts";

export const markdownOperations = Object.assign({}, markdown, mentions, plainText, references, siteExport, structure, copyDetection, langDetect, headline, inspection, frontmatter, draftIssues, checks);
markdownOperations.renderUncachedMarkdown = (...args) => withoutMarkdownParseCache(() => markdownOperations.renderMarkdown(...args));
markdownOperations.admitMarkdown = source => {
  if (markdownOperations.tryRenderMarkdown(source) === null) return "body_unrenderable";
  markdownOperations.mentionSpellings(source);
  markdownOperations.parseEntryReferences(source);
  markdownOperations.extractLinks(source);
  return null;
};
markdownOperations.calibrate = () => {
  const timings = [];
  for (let repeat = 0; repeat < 5; repeat++) for (const lang of ["en", "ja"]) {
    const start = process.threadCpuUsage();
    markdownOperations.renderMarkdown(markdownSpecimen(lang), { lang });
    const cpu = process.threadCpuUsage(start);
    timings.push((cpu.user + cpu.system) / 1000);
  }
  return timings;
};
export function warmMarkdownWorker() {
  markdownOperations.renderMarkdown("Ordinary **text** and $x$.");
  // A cold replacement worker must not charge ordinary text for one-time JIT work.
  for (let repeat = 0; repeat < 2; repeat++) for (const lang of ["en", "ja"]) markdownOperations.renderMarkdown(markdownSpecimen(lang), { lang });
}
