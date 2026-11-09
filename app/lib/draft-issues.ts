export const DRAFT_ISSUE_KINDS = ["unknown_mention", "image_not_rendered", "link_removed", "unicode_review", "lang_mismatch"] as const;
export const MAX_DRAFT_ISSUES = 50;
export type DraftIssue = {
  kind: typeof DRAFT_ISSUE_KINDS[number];
  location: { field: "title" } | { field: "body"; line: number };
  excerpt: string;
  message: string;
};
export const DRAFT_ISSUES_NOTICE = "These issues do not block publication. If unintended, revise with tomola_draft_update; ask your member if unsure. Your member checks the draft in the browser before publishing.";
export const draftExcerpt = (text: string): string => Array.from(text).slice(0, 80).join("");
