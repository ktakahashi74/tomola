import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { VillageTarget } from "~/components/village-target";
import { m } from "~/paraglide/messages.js";
import { renderInRouter } from "./helpers/render-in-router";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

it("keeps an empty destination's explanation visible and associated with the control", async () => {
  const html = await renderInRouter(() => createElement(VillageTarget, { posting: { choices: [], ownHandle: null, selected: "", explicit: false, changed: false, error: null } }));
  const describedBy = /aria-describedby="([^"]+)"/.exec(html)![1].split(" ");
  const alertId = /<p id="([^"]+)" role="alert"/.exec(html)![1];
  expect(describedBy).toContain(alertId);
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain(m.village_target_none());
  expect(html).toContain('href="/villages"');
});
