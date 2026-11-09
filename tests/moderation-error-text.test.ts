import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { ModerationPanel } from "~/components/moderation-panel";
import type { ModError } from "~/lib/mod-error-text";
import { m } from "~/paraglide/messages.js";
import { renderInRouter } from "./helpers/render-in-router";

const response = vi.hoisted(() => ({ error: "confirm_required" as ModError }));
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
vi.mock("react-router", async importOriginal => {
  const router = await importOriginal<typeof import("react-router")>();
  return { ...router, useFetcher: () => ({ Form: router.Form, data: response, state: "idle" }) };
});

it.each([
  ["confirm_required", () => m.mod_error_confirm()],
  ["forbidden", () => m.mod_error_forbidden()],
  ["invalid_state", () => m.mod_error_state()],
  ["invalid_note", () => m.mod_error_note()],
  ["own_entry", () => m.mod_error_own()],
  ["not_found", () => m.mod_error_not_found()],
] satisfies Array<[ModError, () => string]>)("explains a reply moderation refusal: %s", async (error, message) => {
  response.error = error;
  const html = await renderInRouter(() => createElement(ModerationPanel, { entryId: 1, hidden: false, returnTo: "/t/1#c-1", canDelete: true, retainsReply: true }));
  expect(html).toContain(message());
  expect(html).not.toContain(m.error_generic());
});
