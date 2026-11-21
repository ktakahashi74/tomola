import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { checkEntryInput, createReply, createTopic, editEntry, parseTopicText } from "~/lib/entries.server";
import { createDraft, getDraft, publishDraft, updateDraft } from "~/lib/drafts.server";
import { createClientDraft, updateClientDraft } from "~/lib/mcp/drafts.server";
import { drafts } from "~/lib/db/schema";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createApiToken } from "~/lib/tokens.server";
import { bodyWithinLimits, MAX_BODY_BYTES } from "~/lib/body-length";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("hana"); });
afterAll(async () => { await h.restore(); });
const okId = (result: { ok: boolean; id?: number }) => { expect(result.ok).toBe(true); return result.id!; };
const client = { key: "long-body-client", id: "long-body-client", name: "Writer", uri: null, tokenId: null };
const oversized = ["a".repeat(100_001), "あ".repeat(50_001), "𝄞".repeat(65_536) + "a"];

describe("shared body limits at writing boundaries", () => {
  it("previews a signed body with more than 150000 UTF-16 units and rejects oversized fields", async () => {
    const { action } = await import("~/routes/signing");
    const body = "a".repeat(45_952) + "𝔄".repeat(54_048);
    expect(body.length).toBe(154_048);
    expect(bodyWithinLimits(body, "topic")).toBe(true);
    const send = async (body: string) => {
      const session = h.request("/signing", { as: "hana" });
      return action(h.args(new Request(session.url, { method: "POST", headers: { ...Object.fromEntries(session.headers), "content-type": "application/json" }, body: JSON.stringify({ intent: "preview", pathname: "/t/new", fields: [["lang", "en"], ["body", body]] }) }))) as Promise<Response>;
    };
    const preview = await send(body);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ content: { body } });
    const rejected = await send("x".repeat(MAX_BODY_BYTES + 1));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_payload" });
  });
  it("accepts full topics through creation, editing, drafts, publication and MCP", async () => {
    for (const body of ["a".repeat(100_000), "あ".repeat(50_000), "𝄞".repeat(65_536)]) {
      const input = { lang: "en", title: "A long article", body };
      expect(await checkEntryInput("topic", input)).toBeNull();
      expect(parseTopicText(input).ok).toBe(true);
      const id = okId(await createTopic(h.db, h.ids.hana, input));
      expect((await editEntry(h.db, h.ids.hana, id, { ...input, title: "Edited article" })).ok).toBe(true);
      const draftId = okId(await createDraft(h.db, h.ids.hana, { kind: "topic", ...input }));
      expect((await updateDraft(h.db, h.ids.hana, draftId, input)).ok).toBe(true);
      expect((await publishDraft(h.db, h.ids.hana, draftId)).ok).toBe(true);
      const mcpId = okId(await createClientDraft(h.db, h.ids.hana, client, { kind: "topic", ...input }));
      expect((await updateClientDraft(h.db, h.ids.hana, client, mcpId, { ...input, expectedVersion: 1 })).ok).toBe(true);
    }
  }, 30_000);

  it("rejects both limits through every shared service and rechecks publication", async () => {
    const topic = okId(await createTopic(h.db, h.ids.hana, { lang: "en", body: "Short." }));
    const draft = okId(await createDraft(h.db, h.ids.hana, { kind: "topic", lang: "en", body: "Short." }));
    const mcp = okId(await createClientDraft(h.db, h.ids.hana, client, { kind: "topic", lang: "en", body: "Short." }));
    for (const body of oversized) {
      const input = { lang: "en", body };
      expect(await checkEntryInput("topic", input)).toBe("body_too_long");
      expect(parseTopicText({ title: null, body })).toMatchObject({ ok: false, error: "body_too_long" });
      for (const result of [
        await createTopic(h.db, h.ids.hana, input), await editEntry(h.db, h.ids.hana, topic, input),
        await createDraft(h.db, h.ids.hana, { kind: "topic", ...input }), await updateDraft(h.db, h.ids.hana, draft, input),
        await createClientDraft(h.db, h.ids.hana, client, { kind: "topic", ...input }), await updateClientDraft(h.db, h.ids.hana, client, mcp, { ...input, expectedVersion: 1 }),
      ]) expect(result).toMatchObject({ ok: false, error: "body_too_long" });
      await h.db.update(drafts).set({ body }).where(eq(drafts.id, draft));
      expect(await publishDraft(h.db, h.ids.hana, draft)).toMatchObject({ ok: false, error: "body_too_long" });
      expect(await getDraft(h.db, h.ids.hana, draft)).not.toBeNull();
    }
  }, 30_000);

  it("retains reply limits at creation, editing and draft boundaries", async () => {
    const threadId = okId(await createTopic(h.db, h.ids.hana, { lang: "en", body: "Topic." }));
    const body = "あ".repeat(50_000);
    const id = okId(await createReply(h.db, h.ids.hana, threadId, { lang: "ja", body }));
    const draft = okId(await createDraft(h.db, h.ids.hana, { kind: "reply", threadId, lang: "ja", body }));
    expect((await updateDraft(h.db, h.ids.hana, draft, { lang: "ja", body })).ok).toBe(true);
    expect((await publishDraft(h.db, h.ids.hana, draft)).ok).toBe(true);
    for (const body of ["a".repeat(50_001), "あ".repeat(50_001), "😀".repeat(25_001)]) {
      const input = { lang: "ja", body };
      expect(await checkEntryInput("reply", input)).toBe("body_too_long");
      expect(await createReply(h.db, h.ids.hana, threadId, input)).toMatchObject({ error: "body_too_long" });
      expect(await editEntry(h.db, h.ids.hana, id, input)).toMatchObject({ error: "body_too_long" });
      expect(await createDraft(h.db, h.ids.hana, { kind: "reply", threadId, ...input })).toMatchObject({ error: "body_too_long" });
      const pending = okId(await createDraft(h.db, h.ids.hana, { kind: "reply", threadId, lang: "ja" }));
      expect(await updateDraft(h.db, h.ids.hana, pending, input)).toMatchObject({ error: "body_too_long" });
    }
  });

  it("uses the same topic validation in the Markdown API and preview", async () => {
    const token = await createApiToken(h.db, h.ids.hana, { name: "Long article writer", kind: "draft" });
    if (!token.ok) throw new Error("Cannot create fixture token");
    const { action } = await import("~/routes/api.drafts");
    const { action: preview } = await import("~/routes/preview");
    for (const [body, accepted] of [["a".repeat(100_000), true], ["あ".repeat(50_000), true], ["𝄞".repeat(65_536), true], ...oversized.map(body => [body, false])] as [string, boolean][]) {
      const request = new Request(`${BASE}/api/drafts`, { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "text/markdown" }, body: `---\ntype: topic\nlang: en\n---\n${body}` });
      const result = await action({ request, params: {}, context: {} } as never) as Response;
      // The complete document has room for frontmatter around a maximum-sized body.
      expect(result.status).toBe(accepted ? 201 : 400);
      if (!accepted && result.status === 400) expect(await result.json()).toMatchObject({ error: "body_too_long" });
      const rendered = await preview({ request: h.request("/preview", { as: "hana", form: { body, kind: "topic" } }), params: {}, context: {} } as never) as Response;
      expect(rendered.status).toBe(accepted ? 200 : 400);
      if (!accepted) expect(await rendered.json()).toMatchObject({ error: "body_too_long" });
    }
  }, 30_000);
});
