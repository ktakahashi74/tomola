import { createElement } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setTestMessages } from "./stubs/paraglide-messages";
import { jsonMessages } from "./helpers/messages-json";
import { renderInRouter } from "./helpers/render-in-router";
import { NushiVoicePublic } from "~/components/nushi-voice";
import { VillageModerationCard } from "~/components/village-moderation";
import { DELETED_MEMBER_HANDLE } from "~/lib/deleted-member";
import { m } from "~/paraglide/messages.js";
import type { VillageReportCard } from "~/lib/village-moderation.server";

beforeEach(() => setTestMessages(jsonMessages()));
afterEach(() => setTestMessages());

it("renders removal placeholders, departed labels and ordinary dates in public history", async () => {
  const date = "2026-11-15T09:08:07.000Z";
  const html = await renderInRouter(() => createElement(NushiVoicePublic, { voice: { text: "", history: [
    { id: 3, actor: null, removed: true, hidden: false, text: "", date },
    { id: 2, actor: DELETED_MEMBER_HANDLE, removed: false, hidden: false, text: "A public style.", date },
    { id: 1, actor: "owner", removed: false, hidden: true, text: "", date },
  ] } }));
  expect(html).toContain(m.nushi_voice_hidden());
  expect(html).toContain(m.admin_roles_operator());
  expect(html).toContain(m.account_delete_member());
  expect(html).not.toContain("@[deleted]");
  expect(html).toContain('>2026-11-15</time>');
});

it("offers history removals only for matching style reports or direct moderation", async () => {
  const card: VillageReportCard = { kind: "village", reportId: 10, version: "2", owned: false, village: { name: "Garden", description: "", nushiVoice: "Warm.", slug: "garden", language: null, kind: "open", ended: false }, creatorHandle: "owner", ownerHandles: ["owner"],
    voiceHistory: [{ id: 2, text: "Warm.", hidden: false, date: "2026-11-15T09:08:07.000Z" }], reports: [] };
  const render = (direct = false) => renderInRouter(() => createElement(VillageModerationCard, { card: { ...card, reports: card.reports.map(r => ({ ...r, createdAt: r.createdAt.toISOString().slice(0, 10) })) }, handled: false, returnTo: "/mod", direct }));
  expect(await render()).not.toContain('value="village-clear-voice"');
  expect(await render(true)).toContain('value="village-clear-voice"');
  card.reports.push({ id: 11, target: "nushi_voice", voiceEventId: 2, reason: "other", note: "", createdAt: new Date(), aiPriority: null, aiAssessment: null, snapshot: null });
  const html = await render();
  expect(html).toMatch(/name="reportId" value="11"/);
  expect(html).toMatch(/name="voiceEventId" value="2"/);
});
