import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createReply, createTopic, softDeleteEntry } from "~/lib/entries.server";
import { createDraft } from "~/lib/drafts.server";
import { drafts, entries } from "~/lib/db/schema";
import { previewSignedWrite } from "~/lib/signing.server";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("hana"); await h.signIn("kim"); });
afterAll(() => h.restore());

const topic = async (title: string, body: string, extra: Record<string, unknown> = {}) => {
  const r = await createTopic(h.db, h.ids.hana, { lang: "en", title, body, ...extra });
  if (!r.ok) throw new Error(r.error);
  return r.id;
};
const reply = async (threadId: number, body: string, parentId?: number) => {
  const r = await createReply(h.db, h.ids.hana, threadId, { lang: "en", body, ...(parentId ? { parentId } : {}) });
  if (!r.ok) throw new Error(r.error);
  return r.id;
};
const form = (fields: Record<string, string>) => { const f = new FormData(); f.set("body", "A new reply"); f.set("lang", "en"); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
const contextOf = async (path: string, fields: Record<string, string> = {}, userId = h.ids.kim) => (await previewSignedWrite(h.db, userId, path, form(fields))).targetContext;

describe("signing preview target context", () => {
  it("shows the topic and the reply being answered on a normal reply", async () => {
    const t = await topic("Live topic", "Live topic body");
    const r = await reply(t, "Live reply body");
    const context = await contextOf(`/t/${t}`, { parentId: String(r) });
    expect(context.thread?.body).toBe("Live topic body");
    expect(context.parent?.body).toBe("Live reply body");
  });

  it("does not reveal a reply that survives its deleted topic", async () => {
    const t = await topic("Doomed topic", "Doomed topic body");
    const r = await reply(t, "Secret reply under a deleted topic");
    await softDeleteEntry(h.db, t);
    const live = await topic("Live target", "Live target body");
    // As the parent of a reply in the deleted topic.
    expect(await contextOf(`/t/${t}`, { parentId: String(r) })).toEqual({ thread: null, parent: null });
    // As the reply's own id used as a topic id, and as an alternative framing's original.
    expect(await contextOf(`/t/${r}`)).toEqual({ thread: null, parent: null });
    expect(await contextOf("/t/new", { altOf: String(r) })).toEqual({ thread: null, parent: null });
    // As a parent of a reply to some other live topic.
    const other = await contextOf(`/t/${live}`, { parentId: String(r) });
    expect(other.thread?.body).toBe("Live target body");
    expect(other.parent).toBeNull();
  });

  it("does not reveal the deleted topic itself or its replies through a plain reply preview", async () => {
    const t = await topic("Deleted root", "Deleted root body");
    await softDeleteEntry(h.db, t);
    expect(await contextOf(`/t/${t}`)).toEqual({ thread: null, parent: null });
  });

  it("returns no content for targets of the wrong kind or from another topic", async () => {
    const a = await topic("Topic A", "Topic A body");
    const b = await topic("Topic B", "Topic B body");
    const ra = await reply(a, "Reply in A");
    const rb = await reply(b, "Reply in B");
    // A reply of another topic as the parent.
    expect(await contextOf(`/t/${a}`, { parentId: String(rb) })).toMatchObject({ parent: null });
    // A topic as the parent.
    expect(await contextOf(`/t/${a}`, { parentId: String(b) })).toMatchObject({ parent: null });
    // A reply as the original of an alternative framing.
    expect(await contextOf("/t/new", { altOf: String(ra) })).toEqual({ thread: null, parent: null });
    // The reply's own thread still shows normally.
    expect((await contextOf(`/t/${a}`, { parentId: String(ra) })).parent?.body).toBe("Reply in A");
    // A reply id used as the thread of a reply form.
    expect(await contextOf(`/t/${ra}`)).toMatchObject({ thread: null });
  });

  it("keeps showing a visible reply under a hidden topic, but not the hidden topic", async () => {
    const t = await topic("Hidden topic", "Hidden topic body");
    const r = await reply(t, "Visible reply under hidden topic");
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, t));
    const context = await contextOf(`/t/${t}`, { parentId: String(r) });
    expect(context.thread).toBeNull();
    expect(context.parent?.body).toBe("Visible reply under hidden topic");
  });

  it("does not show hidden replies", async () => {
    const t = await topic("Topic with hidden reply", "Body");
    const r = await reply(t, "Hidden reply body");
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, r));
    expect((await contextOf(`/t/${t}`, { parentId: String(r) })).parent).toBeNull();
  });

  it("does not reveal replies of a deleted topic when publishing a saved draft", async () => {
    const t = await topic("Draft target topic", "Draft target body");
    const r = await reply(t, "Reply behind a draft");
    const draft = await createDraft(h.db, h.ids.kim, { kind: "reply", threadId: t, parentId: r, body: "Draft reply", lang: "en" });
    if (!draft.ok) throw new Error(draft.error);
    const publish = (userId: string) => previewSignedWrite(h.db, userId, `/drafts/${draft.id}`, form({ intent: "publish" }));
    const before = (await publish(h.ids.kim)).targetContext;
    expect(before.thread?.body).toBe("Draft target body");
    expect(before.parent?.body).toBe("Reply behind a draft");
    await softDeleteEntry(h.db, t);
    expect((await publish(h.ids.kim)).targetContext).toEqual({ thread: null, parent: null });
  });

  it("does not reveal replies of a deleted topic through a draft whose parent belongs elsewhere", async () => {
    const t = await topic("Doomed draft topic", "Doomed body");
    const r = await reply(t, "Reply that must stay private");
    const live = await topic("Draft live topic", "Draft live body");
    const draft = await createDraft(h.db, h.ids.kim, { kind: "reply", threadId: live, body: "Draft", lang: "en" });
    if (!draft.ok) throw new Error(draft.error);
    // Forge the stored parent directly: the draft routes validate it, but the preview must not rely on that.
    await h.db.update(drafts).set({ parentId: r }).where(eq(drafts.id, draft.id));
    await softDeleteEntry(h.db, t);
    const context = (await previewSignedWrite(h.db, h.ids.kim, `/drafts/${draft.id}`, form({ intent: "publish" }))).targetContext;
    expect(context.thread?.body).toBe("Draft live body");
    expect(context.parent).toBeNull();
  });
});
