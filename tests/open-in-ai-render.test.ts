import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OpenInAi } from "~/components/open-in-ai";
import AiChoiceForm from "~/components/ai-choice-form";
import { CHATGPT_TEMPLATE, CLAUDE_TEMPLATE } from "~/lib/open-in-ai";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

describe("OpenInAi server rendering", () => {
  it("keeps the default Markdown fallback and lets a repeated entrance omit it", () => {
    const props = { mdUrl: "https://example.com/t/5.md", mdPath: "/t/5.md" };
    expect(renderToStaticMarkup(createElement(OpenInAi, props))).toContain('href="/t/5.md"');
    expect(renderToStaticMarkup(createElement(OpenInAi, { ...props, showNoScript: false }))).toBe("");
  });
  it("shows sign-in notes instead of provider URL templates in the shared form", () => {
    const html = renderToStaticMarkup(createElement(AiChoiceForm, { initial: { provider: "custom", template: "https://ai.example/?q={prompt}" }, submitLabel: m.open_in_ai_save(), onSubmit: () => {} }));
    for (const provider of [m.open_in_ai_chatgpt(), m.open_in_ai_claude()]) {
      expect(html).toContain(m.open_in_ai_provider_login({ name: provider }));
    }
    expect(html).not.toContain(CHATGPT_TEMPLATE);
    expect(html).not.toContain(CLAUDE_TEMPLATE);
    expect(html).toContain("https://ai.example/?q={prompt}");
    expect(html).toContain(m.open_in_ai_template());
  });
});
