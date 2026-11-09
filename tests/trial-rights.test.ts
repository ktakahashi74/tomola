import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { profiles, entries, stances, stanceChanges, appeals } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { hideEntry } from "~/lib/moderation.server";
import { setStance } from "~/lib/stances.server";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { setupRouteHarness } from "./helpers/route-harness";

vi.hoisted(() => vi.resetModules());
vi.mock("~/lib/notice-sources.server", () => ({ noticesAvailable: () => ({ privacy: true, terms: true }), trialParticipationRequired: () => true }));

it("keeps personal deletion, export, appeals and their pages available before participation consent", async () => {
  const h = await setupRouteHarness();
  try {
    await h.signIn("rights_owner");
    await h.signIn("rights_other");
    const owner = h.ids.rights_owner;
    const topic = await createTopic(h.db, owner, { title: "Delete this", body: "My post.", lang: "en", asksStance: true });
    const reported = await createTopic(h.db, owner, { title: "Appeal this", body: "My other post.", lang: "en" });
    if (!topic.ok || !reported.ok) throw new Error("Fixture topic failed");
    expect(await setStance(h.db, owner, { questionId: topic.id, position: "agree", expectedVersion: 0 })).toMatchObject({ ok: true });
    const hidden = await hideEntry(h.db, { id: h.ids.rights_other, scope: { operator: true, langs: [] } }, { entryId: reported.id, reason: "spam", note: "Review requested" });
    if (!hidden.ok) throw new Error("Fixture moderation failed");
    await h.db.update(profiles).set({ residenceCountry: null, adultConfirmedAt: null, trialConsentVersion: null, trialConsentAt: null }).where(eq(profiles.userId, owner));
    for (const path of ["/settings", "/settings/export", "/settings/stances", "/settings/chat", "/settings/media", "/settings/tokens", "/settings/connections", "/notifications", "/notifications/1/open", "/following", "/navigation-header", "/invites/new", "/mcp/consent", "/suspended", `/appeal/${hidden.actionId}`, `/t/${topic.id}`, `/t/${topic.id}/history`, `/t/${topic.id}/history/current`, `/c/${topic.id}/history/1?delete=1`, "/u/rights_owner", "/v/en/chat"]) {
      expect(await requireMember(h.request(path, { as: "rights_owner" }))).toMatchObject({ user: { id: owner } });
    }
    expect(await h.outcome(() => requireMember(h.request("/", { as: "rights_owner" })))).toMatchObject({ status: 302 });
    expect(await h.outcome(() => requireWriter(h.request("/t/new", { as: "rights_owner", form: { body: "No posting yet" } })))).toMatchObject({ status: 302 });
    const history = await import("~/routes/entry-history");
    expect(await history.loader(h.args(h.request(`/t/${topic.id}/history/current`, { as: "rights_owner" }), { id: String(topic.id), version: "current" }))).toMatchObject({ history: { owner: true, selected: { body: "My post." } } });
    const exporting = await import("~/routes/settings-export");
    const exported = await exporting.loader(h.args(h.request("/settings/export", { as: "rights_owner" })));
    expect(exported.status).toBe(200);
    expect((await exported.json()).profile.trial_consent_at).toBeNull();
    const appeal = await import("~/routes/appeal");
    expect(await h.outcome(() => appeal.loader(h.args(h.request(`/appeal/${hidden.actionId}`, { as: "rights_owner" }), { actionId: String(hidden.actionId) })))).toMatchObject({ status: 200 });
    expect(await h.outcome(() => appeal.action(h.args(h.request(`/appeal/${hidden.actionId}`, { as: "rights_owner", form: { text: "Please review this decision." } }), { actionId: String(hidden.actionId) })))).toMatchObject({ status: 302, location: `/appeal/${hidden.actionId}?sent=1` });
    expect(await h.db.select().from(appeals)).toHaveLength(1);
    const records = await import("~/routes/settings-stances");
    expect(await h.outcome(() => records.action(h.args(h.request("/settings/stances", { as: "rights_owner", form: { intent: "delete", questionId: String(topic.id), confirm: "1" } }))))).toMatchObject({ status: 302 });
    expect(await h.db.select().from(stances)).toHaveLength(0);
    expect(await h.db.select().from(stanceChanges)).toHaveLength(0);
    const route = await import("~/routes/topic");
    expect(await h.outcome(() => route.action(h.args(h.request(`/t/${topic.id}`, { as: "rights_owner", form: { intent: "delete", entryId: String(topic.id), confirm: "1" } }), { id: String(topic.id) })))).toMatchObject({ status: 302 });
    expect((await h.db.select().from(entries).where(eq(entries.id, topic.id)))[0].deletedAt).not.toBeNull();
  } finally { h.restore(); }
});
