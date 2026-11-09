import { describe, expect, it } from "vitest";
import { parseNotice, noticeFor, renderNotice } from "~/lib/notices.server";
import { noticeSources } from "~/lib/notice-sources.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";

describe("operator notices", () => {
  const filled = { ja: "# 日本語\n\n本文\n\n## 6. 窓口\n\n連絡先", en: "# English\n\nNotice\n\n## 6. Contact\n\nContact us" };
  it("renders the configured editions through the shared safe Markdown pipeline", async () => {
    for (const kind of ["privacy", "terms"] as const) for (const lang of ["ja", "en"]) {
      const doc = noticeFor(kind, lang);
      expect(doc.markdown).toBe(noticeSources(kind)[lang as "en" | "ja"]);
      const rendered = await withMarkdownRead(() => renderNotice(doc));
      expect(rendered.sections.length).toBeGreaterThan(5);
      expect(rendered.sections.every(section => section.html.includes("<h2"))).toBe(true);
    }
  });
  it("selects Japanese or English and reports fallback for other screen languages", () => {
    expect(noticeFor("privacy", "ja", filled)).toMatchObject({ requested: "ja", lang: "ja", fallback: false });
    expect(noticeFor("privacy", "ko", filled)).toMatchObject({ requested: "ko", lang: "en", fallback: true });
    expect(noticeFor("privacy", "en", filled).markdown).toBe(filled.en);
    expect(parseNotice(filled.ja)).toMatchObject({ title: "日本語", sections: [{ id: "s6" }] });
  });
});
