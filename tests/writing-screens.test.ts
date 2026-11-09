import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDraft, deleteLinkedDraft, getDraft, updateDraft } from "~/lib/drafts.server";
import { createReply, createTopic, deleteOwnEntry } from "~/lib/entries.server";
import { drafts } from "~/lib/db/schema";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("writer"); await h.signIn("other"); });
afterAll(() => h.restore());

const form = (fields: Record<string, string>) => { const data = new FormData(); for (const [name, value] of Object.entries(fields)) data.set(name, value); return data; };
async function ownDraft(as: string, body = "Made for an AI") {
  const draft = await createDraft(h.db, h.ids[as], { kind: "topic", lang: "en", body });
  if (!draft.ok) throw new Error("draft failed");
  return draft.id;
}

describe("the notice after posting reads the translation states of the member's own topic only", () => {
  it("answers the author, and 404 for anyone else, for a reply, a deleted topic and a bad id", async () => {
    const { loader } = await import("~/routes/posted-status");
    const topic = await createTopic(h.db, h.ids.writer, { lang: "en", body: "Own topic" });
    const gone = await createTopic(h.db, h.ids.writer, { lang: "en", body: "Topic to delete" });
    if (!topic.ok || !gone.ok) throw new Error("topic failed");
    const reply = await createReply(h.db, h.ids.writer, topic.id, { lang: "en", body: "Own reply" });
    if (!reply.ok) throw new Error("reply failed");
    expect((await deleteOwnEntry(h.db, h.ids.writer, gone.id)).ok).toBe(true);
    const status = (as: string, id: string) => h.outcome(() => loader(h.args(h.request(`/t/${id}/posted-status`, { as }), { id })));
    expect((await status("writer", String(topic.id))).status).toBe(200);
    expect((await status("other", String(topic.id))).status).toBe(404);
    expect((await status("writer", String(reply.id))).status).toBe(404);
    expect((await status("writer", String(gone.id))).status).toBe(404);
    expect((await status("writer", "abc")).status).toBe(404);
  });
});

describe("the draft that writing with an AI made", () => {
  it("is removed by a post only when it is the member's own and still at the version the screen saw", async () => {
    const mine = await ownDraft("writer");
    const theirs = await ownDraft("other");
    expect(await deleteLinkedDraft(h.db, h.ids.writer, form({ fromDraft: String(theirs), fromDraftVersion: "1" }))).toBe(false);
    expect(await getDraft(h.db, h.ids.other, theirs)).not.toBeNull();
    // Without the version the screen saw, nothing is removed.
    expect(await deleteLinkedDraft(h.db, h.ids.writer, form({ fromDraft: String(mine) }))).toBe(false);
    // An AI changed the draft after the screen saved it (version 2): it is kept.
    expect((await updateDraft(h.db, h.ids.writer, mine, { lang: "en", body: "The AI's version" }, { expectedVersion: 1 })).ok).toBe(true);
    expect(await deleteLinkedDraft(h.db, h.ids.writer, form({ fromDraft: String(mine), fromDraftVersion: "1" }))).toBe(false);
    expect((await getDraft(h.db, h.ids.writer, mine))?.body).toBe("The AI's version");
    expect(await deleteLinkedDraft(h.db, h.ids.writer, form({ fromDraft: String(mine), fromDraftVersion: "2" }))).toBe(true);
    expect(await getDraft(h.db, h.ids.writer, mine)).toBeNull();
  });

  it("is updated in place by Save draft, and kept when an AI changed it since", async () => {
    const { action } = await import("~/routes/topic-new");
    const id = await ownDraft("writer", "First text");
    const save = (version: number, body: string) => h.outcome(async () => action(await h.signedArgs(h.request("/t/new", { as: "writer", form: { intent: "draft", body, fromDraft: String(id), fromDraftVersion: String(version) } }))));
    const before = (await h.db.select().from(drafts).where(eq(drafts.authorId, h.ids.writer))).length;
    const first = await save(1, "Edited text");
    expect(first).toMatchObject({ status: 302, location: `/drafts/${id}?saved=1` });
    expect(await h.db.select().from(drafts).where(eq(drafts.authorId, h.ids.writer))).toHaveLength(before);
    expect(await getDraft(h.db, h.ids.writer, id)).toMatchObject({ body: "Edited text", version: 2 });
    // The screen still says version 1: the draft moved on (an AI), so this is refused and the draft is not overwritten.
    const stale = await save(1, "Overwriting text");
    expect(stale).toMatchObject({ status: 409, value: { data: { error: "draft_conflict" } } });
    expect(await getDraft(h.db, h.ids.writer, id)).toMatchObject({ body: "Edited text", version: 2 });
    // "Save as a new draft" keeps what is on the screen as a copy, and leaves the draft that moved on as it is.
    const copy = await h.outcome(async () => action(await h.signedArgs(h.request("/t/new?newdraft=1", { as: "writer", form: { intent: "draft", body: "Overwriting text", fromDraft: String(id), fromDraftVersion: "1" } }))));
    expect(copy.status).toBe(302);
    expect(copy.location).not.toContain(`/drafts/${id}?`);
    expect(await getDraft(h.db, h.ids.writer, id)).toMatchObject({ body: "Edited text", version: 2 });
    expect(await h.db.select().from(drafts).where(eq(drafts.authorId, h.ids.writer))).toHaveLength(before + 1);
  });

  it("is removed with the post, but only at the version seen", async () => {
    const { action } = await import("~/routes/topic-new");
    const kept = await ownDraft("writer", "Moved on");
    const removed = await ownDraft("writer", "Unchanged");
    await updateDraft(h.db, h.ids.writer, kept, { lang: "en", body: "The AI's version" }, { expectedVersion: 1 });
    const post = (id: number, version: number, body: string) => h.outcome(async () => action(await h.signedArgs(h.request("/t/new", { as: "writer", form: { body, fromDraft: String(id), fromDraftVersion: String(version) } }))));
    expect((await post(kept, 1, "Posted from the first screen")).status).toBe(302);
    expect(await getDraft(h.db, h.ids.writer, kept)).not.toBeNull();
    expect((await post(removed, 1, "Posted without a change")).status).toBe(302);
    expect(await getDraft(h.db, h.ids.writer, removed)).toBeNull();
  });
});
