import { markdownFixture, SLOW_MARKDOWN } from "./helpers/markdown-fixture";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drafts, entries, entryRevisions } from "~/lib/db/schema";
import { createTopic, createReply, editEntry, getThread } from "~/lib/entries.server";
import { createDraft, getDraft, publishDraft } from "~/lib/drafts.server";
import { createClientDraft, updateClientDraft } from "~/lib/mcp/drafts.server";
import { handleDraftCreate } from "~/lib/api/drafts-api.server";
import { createApiToken } from "~/lib/tokens.server";
import { previewSignedWrite } from "~/lib/signing.server";
import { translateChecked } from "~/lib/llm/translate.server";
import { isUsablePrimary } from "~/lib/display";
import { createMarkdownExecutor, setMarkdownExecutorForTests } from "~/lib/markdown-budget.server";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { getMd } from "./helpers/md";

let h: RouteHarness;
const costly = SLOW_MARKDOWN;
let fixture: ReturnType<typeof markdownFixture>;
beforeAll(async () => {
  fixture = markdownFixture();
  await setMarkdownExecutorForTests(fixture.executor({ cpuMs: 250 }));
  h = await setupRouteHarness();
  await h.signIn("writer", { homeArea: "en", readLangs: ["en"] });
});
afterAll(() => { h.restore(); fixture.remove(); });

describe("Markdown admission and saved content", () => {
  it("refuses each write path before changing content and preserves the draft", async () => {
    const member = h.ids.writer;
    const topic = await createTopic(h.db, member, { lang: "en", title: "Control", body: "Original text.\n" });
    if (!topic.ok) throw new Error("control failed");
    const denied = { ok: false, error: "body_too_complex" };
    expect(await createTopic(h.db, member, { lang: "en", body: costly })).toEqual(denied);
    expect(await createReply(h.db, member, topic.id, { lang: "en", body: costly })).toEqual(denied);
    expect(await editEntry(h.db, member, topic.id, { title: "Changed", body: costly })).toEqual(denied);
    expect((await getThread(h.db, topic.id))!.topic.body).toBe("Original text.\n");
    expect(await h.db.select().from(entryRevisions).where(eq(entryRevisions.entryId, topic.id))).toEqual([]);
    const saved = await createDraft(h.db, member, { kind: "topic", lang: "en", body: costly });
    if (!saved.ok) throw new Error("draft save must not interpret text");
    expect(await publishDraft(h.db, member, saved.id)).toEqual(denied);
    expect((await getDraft(h.db, member, saved.id))!.body).toBe(costly);

    const { action: preview } = await import("~/routes/preview");
    const response = await preview(h.args(h.request("/preview", { as: "writer", form: { body: costly, lang: "en" } }))) as Response;
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "body_too_complex" });
    const form = new FormData(); form.set("body", costly); form.set("lang", "en");
    await expect(previewSignedWrite(h.db, member, "/t/new", form)).rejects.toMatchObject({ code: "body_too_complex", status: 400 });
    const { action: aiDraft } = await import("~/routes/ai-draft");
    const ai = await aiDraft(h.args(h.request("/ai/draft", { as: "writer", form: { ownerId: member, body: costly, lang: "en" } }))) as Response;
    expect(ai.status).toBe(400); expect(await ai.json()).toEqual({ error: "body_too_complex" });

    const token = await createApiToken(h.db, member, { name: "test client", kind: "draft" });
    if (!token.ok) throw new Error("token failed");
    const api = await handleDraftCreate(new Request(`${BASE}/api/drafts`, { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "text/markdown" }, body: costly }), { db: h.db });
    expect(api.status).toBe(400); expect((await api.json()).error).toBe("body_too_complex");
    const client = { key: "test:markdown", id: "test:markdown", name: "Test client", uri: null, tokenId: null };
    expect(await createClientDraft(h.db, member, client, { kind: "topic", lang: "en", body: costly })).toEqual(denied);
    const owned = await createClientDraft(h.db, member, client, { kind: "topic", lang: "en", body: "Client draft." });
    if (!owned.ok) throw new Error("client control failed");
    expect(await updateClientDraft(h.db, member, client, owned.id, { body: costly })).toEqual(denied);
    expect((await getDraft(h.db, member, owned.id))!.body).toBe("Client draft.");
    expect((await h.db.select().from(drafts)).length).toBe(2);
  }, 20_000);

  it("hides an over-budget translation and stops after one retry", async () => {
    const translate = vi.fn(async () => ({ text: costly, engine: "fake" as const, model: "fake", promptVersion: "test", inputTokens: 1, outputTokens: 1 }));
    const result = await translateChecked({ id: "fake", model: "fake", translate }, { text: "A normal original.", from: "en", to: "ja", glossary: [] });
    expect(translate).toHaveBeenCalledTimes(2); expect(result.attempts).toBe(2);
    expect(result.flags).toContain("body_too_complex");
    expect(isUsablePrimary({ sourceHash: "source", flags: result.flags }, "source")).toBe(false);
  }, 20_000);

  it("shows saved costly text as escaped source and keeps anonymous Markdown reads available", async () => {
    const created = await createTopic(h.db, h.ids.writer, { lang: "en", body: "Initial." });
    if (!created.ok) throw new Error("control failed");
    const source = costly.slice(0, 49_960) + "\n<script>example</script>";
    await h.db.update(entries).set({ body: source, html: null, cardHtml: null, htmlVersion: 0 }).where(eq(entries.id, created.id));
    const thread = await getThread(h.db, created.id);
    expect(thread!.topic.html).toContain('<pre class="whitespace-pre-wrap">');
    expect(thread!.topic.html).toContain("&lt;script&gt;example&lt;/script&gt;");
    expect(thread!.topic.body).toBe(source);
    vi.stubEnv("PUBLIC_READING", "1");
    try {
      for (let i = 0; i < 3; i++) {
        const response = await getMd(h, `/t/${created.id}.md`);
        expect(response.status).toBe(200); expect(await response.text()).toContain(source);
      }
    } finally { vi.unstubAllEnvs(); }
  }, 20_000);
});
