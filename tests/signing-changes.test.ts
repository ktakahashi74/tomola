import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SigningChanges } from "~/components/signed-form";
import type { SigningContent } from "~/lib/signing";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const content = (title: string | null): SigningContent => ({ title, body: "Unchanged body", lang: "en" });
function sections(viewed: string | null, current: string | null, accepted: string | null) {
  const html = renderToStaticMarkup(createElement(SigningChanges, {
    preview: { viewed: content(viewed), current: content(current), content: content(accepted) },
  }));
  return [...html.matchAll(/<details\b[^>]*>.*?<\/details>/g)].map(match => match[0]);
}

it("shows an AI title deletion separately from restoring the previously viewed title", () => {
  const [sinceOpened, accepting] = sections("Old", null, "Old");
  expect(sinceOpened).toMatch(/<details\b[^>]*\bopen(?:[\s=>])/);
  expect(sinceOpened).toContain("Title: Old → ");
  expect(accepting).toMatch(/<details\b[^>]*\bopen(?:[\s=>])/);
  expect(accepting).toContain("Title:  → Old");
});

it("shows a member's new title only among accepted edits, not as an unseen AI change", () => {
  const [sinceOpened, accepting] = sections(null, null, "New");
  expect(sinceOpened).not.toContain("open=");
  expect(sinceOpened).not.toContain("Title:");
  expect(accepting).toMatch(/<details\b[^>]*\bopen(?:[\s=>])/);
  expect(accepting).toContain("Title:  → New");
});

it("shows accepting the AI title deletion without inventing a second member edit", () => {
  const rendered = sections("Old", null, null);
  expect(rendered).toHaveLength(1);
  expect(rendered[0]).toContain("Title: Old → ");
});
