import { expect, it } from "vitest";
import { selectedRecordsMarkdown } from "~/lib/personal-records";
it("copies exactly the consciously selected records, excluding all others", () => {
  const records = [1, 2].map(questionId => ({ questionId, title: { text: `Question ${questionId}` }, state: "visible", position: "agree", changes: [{ from: null, to: "agree", at: "2026-10-02 12:00", atIso: "2026-10-02T12:00:01Z", trigger: null }] }));
  expect(selectedRecordsMarkdown(records, new Set())).toBe("");
  const markdown = selectedRecordsMarkdown(records, new Set([2]));
  expect(markdown).toContain("Question #2"); expect(markdown).not.toContain("Question #1");
  expect(markdown).toContain("2026-10-02T12:00:01Z"); expect(markdown).toContain("content_trust: untrusted_user_content");
});
