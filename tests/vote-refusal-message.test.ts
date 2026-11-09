import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { EntryReactions } from "~/components/reactions";
import { m } from "~/paraglide/messages.js";
import { renderInRouter } from "./helpers/render-in-router";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
vi.mock("react-router", async importOriginal => {
  const router = await importOriginal<typeof import("react-router")>();
  return { ...router, useFetcher: () => ({ Form: router.Form, data: { ok: false, entryId: 1, error: "own_entry" }, state: "idle" }) };
});

it("describes an own-entry vote refusal without a moderation permission message", async () => {
  const html = await renderInRouter(() => createElement(EntryReactions, { entryId: 1, reactions: { insightful: { total: 0, langs: 0 }, mine: false }, canVote: true, anchor: "#p-1" }));
  expect(html).toContain(m.error_generic());
  expect(html).not.toContain(m.mod_error_forbidden());
});
