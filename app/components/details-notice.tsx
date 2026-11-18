import { useEffect, useRef, useState } from "react";
import type { DetailsIssueReason, MarkdownNode } from "~/lib/markdown-details";
import { m } from "~/paraglide/messages.js";
import { BODY_MAX_LENGTH } from "~/lib/rich-editor";

type Issue = { line: number; reason: DetailsIssueReason };

// Load the shared grammar only when the body could contain a container. Plain
// Markdown writing and reading never fetch the editor's parsing dependencies.
export function DetailsNotice() {
  const root = useRef<HTMLDivElement>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  useEffect(() => {
    const body = root.current?.closest("form")?.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
    if (!body) return;
    let timer: ReturnType<typeof setTimeout>;
    let revision = 0;
    const inspect = () => {
      clearTimeout(timer);
      const current = ++revision;
      const source = body.value;
      if (source.length > BODY_MAX_LENGTH || !source.includes(":::")) { setIssues([]); return; }
      timer = setTimeout(() => {
        void import("~/lib/markdown-rules").then(({ createMarkdownProcessor }) => {
          if (current !== revision) return;
          const next: Issue[] = [];
          const walk = (node: MarkdownNode) => {
            if (node.data?.detailsIssue && next.length < 50) next.push({ line: node.position?.start.line ?? 1, reason: node.data.detailsIssue });
            node.children?.forEach(walk);
          };
          walk(createMarkdownProcessor().parse(source) as unknown as MarkdownNode);
          setIssues(next);
        }).catch(() => { /* Server draft diagnostics remain available. */ });
      }, 400);
    };
    inspect();
    body.addEventListener("input", inspect);
    return () => { revision++; clearTimeout(timer); body.removeEventListener("input", inspect); };
  }, []);
  const reasons = { name: m.draft_details_name, unclosed: m.draft_details_unclosed, attributes: m.draft_details_attributes, depth: m.draft_details_depth };
  return <div ref={root} role="status" className="ui-help text-notice-emphasis">
    {issues.map(({ line, reason }, index) => <p key={index}>{reason === "summary_footnote" ? m.draft_details_summary_footnote({ line }) : m.draft_details_literal({ line, reason: reasons[reason]() })}</p>)}
  </div>;
}
