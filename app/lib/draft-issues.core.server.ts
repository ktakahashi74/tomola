import { inspectDraftRendering } from "./markdown.core.server";
import { draftMentionIssues, type MentionTargets } from "./mentions-md.core.server";
import { MAX_DRAFT_ISSUES } from "./draft-issues";

export function inspectDraftMarkdown(body: string, lang: string, targets: MentionTargets, authorId: string) {
  const rendered = inspectDraftRendering(body, lang);
  return { issues: [...draftMentionIssues(body, targets, authorId), ...rendered.issues].slice(0, MAX_DRAFT_ISSUES + 1), images: rendered.images };
}
