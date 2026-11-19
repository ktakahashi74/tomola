import * as aiVisible from "./ai-visible-text.core.server.ts";
import * as markdown from "./markdown.core.server.ts";
import * as mentions from "./mentions-md.core.server.ts";
import * as plainText from "./plain-text.core.server.ts";
import * as references from "./entry-references.core.server.ts";
import * as siteExport from "./site-export-format.core.server.ts";
import * as structure from "./llm/structure.core.server.ts";
import * as copyDetection from "./llm/copy-detection.core.server.ts";
import * as langDetect from "./lang-detect.core.server.ts";
import * as headline from "./headline.core.server.ts";
import * as inspection from "./llm/translation-inspect.core.server.ts";
import * as frontmatter from "./entry-frontmatter.core.server.ts";
import * as draftIssues from "./draft-issues.core.server.ts";
import * as checks from "./eval/checks.core.server.ts";
import { markdownSpecimen } from "./markdown-specimen.ts";
import { withoutMarkdownParseCache } from "./markdown-parser.core.server.ts";

const core = {
  ...aiVisible,
  ...markdown,
  ...mentions,
  ...plainText,
  ...references,
  ...siteExport,
  ...structure,
  ...copyDetection,
  ...langDetect,
  ...headline,
  ...inspection,
  ...frontmatter,
  ...draftIssues,
  ...checks,
};

export const markdownOperations = {
  ...core,
  renderUncachedMarkdown(...args: Parameters<typeof core.renderMarkdown>) {
    return withoutMarkdownParseCache(() => core.renderMarkdown(...args));
  },
  admitMarkdown(source: string): "body_unrenderable" | null {
    if (core.tryRenderMarkdown(source) === null) return "body_unrenderable";
    core.mentionSpellings(source);
    core.parseEntryReferences(source);
    core.extractLinks(source);
    return null;
  },
  calibrate() {
    const timings: number[] = [];
    for (let repeat = 0; repeat < 5; repeat++) for (const lang of ["en", "ja"] as const) {
      const start = process.threadCpuUsage();
      core.renderMarkdown(markdownSpecimen(lang), { lang });
      const cpu = process.threadCpuUsage(start);
      timings.push((cpu.user + cpu.system) / 1000);
    }
    return timings;
  },
};
export function warmMarkdownWorker() {
  markdownOperations.renderMarkdown("Ordinary **text** and $x$.");
  // A cold replacement worker must not charge ordinary text for one-time JIT work.
  for (let repeat = 0; repeat < 2; repeat++) for (const lang of ["en", "ja"] as const) markdownOperations.renderMarkdown(markdownSpecimen(lang), { lang });
}
