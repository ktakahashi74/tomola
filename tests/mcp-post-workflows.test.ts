import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { draftReceipts, drafts, entries, entryEditProposals, memberSignatures, profiles } from "~/lib/db/schema";
import { publishDraft } from "~/lib/drafts.server";
import { createReply, createTopic, deleteOwnEntry, editEntry } from "~/lib/entries.server";
import { createClientDraft, deleteClientDraft, getClientDraftStatus, updateClientDraft, type McpClientIdentity } from "~/lib/mcp/drafts.server";
import { confirmEntryDeletion, discardEntryEdit, exportOwnEntryEditProposals, getClientEntryEdit, getClientEntryEditStatus, getEntryDeletionReview, prepareEntryDeletion, prepareEntryEdit, pruneEntryEditProposals } from "~/lib/mcp/post-proposals.server";
import { addMember } from "./helpers/db";
import { expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { attachSigningProof, signingCredential } from "./helpers/signing";

const client: McpClientIdentity = { key: "oauth:test-editor", id: "test-editor", name: "Test editor", uri: null, tokenId: null };
const otherClient: McpClientIdentity = { ...client, key: "oauth:other-editor", id: "other-editor" };
const body = "The proposed source text.";

function success<T extends { ok: true } | { ok: false; error: string }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(result.error);
  return result as Extract<T, { ok: true }>;
}

describe("MCP post approvals through the browser routes", () => {
  let h: RouteHarness;
  let owner: string;
  let differentMember: string;
  beforeAll(async () => {
    h = await setupRouteHarness();
    owner = await h.signIn("workflow_owner");
    differentMember = await h.signIn("workflow_reader");
  }, 120_000);
  afterAll(() => h?.restore());

  it("rejects stale browser save, discard and publish of an API draft and tracks its final post", async () => {
    const { action } = await import("~/routes/draft");
    const input = { kind: "topic", lang: "en", title: "Draft for review", body, requestId: "browser-version" };
    const made = success(await createClientDraft(h.db, owner, client, input));
    expect(made.status).toEqual({ draftId: made.id, status: "pending", version: 1 });
    const updated = success(await updateClientDraft(h.db, owner, client, made.id, { expectedVersion: 1, body: "The newer source text." }));
    expect(updated.draft.version).toBe(2);
    const submit = (intent: string, version: number) => h.outcome(() => action(h.args(h.request(`/drafts/${made.id}`, {
      as: "workflow_owner", form: { intent, version: String(version), title: input.title, body, lang: "en" },
    }), { id: String(made.id) })));
    for (const intent of ["save", "delete", "publish"]) expect(await submit(intent, 1)).toMatchObject({ status: 409 });
    expect(await getClientDraftStatus(h.db, owner, client, made.id)).toMatchObject({ status: "pending", version: 2 });
    expect(await getClientDraftStatus(h.db, owner, otherClient, made.id)).toEqual({ draftId: made.id, status: "unknown" });
    expect(await getClientDraftStatus(h.db, differentMember, client, made.id)).toEqual({ draftId: made.id, status: "unknown" });
    const published = await submit("publish", 2);
    expect(published).toMatchObject({ status: 302 });
    const [post] = await h.db.select().from(entries).where(eq(entries.title, input.title));
    const receipt = await getClientDraftStatus(h.db, owner, client, made.id);
    expect(receipt).toMatchObject({ status: "published", entryUrl: expect.stringMatching(new RegExp(`/t/${post.id}$`)) });
    expect(await createClientDraft(h.db, owner, client, input)).toMatchObject({ ok: true, id: made.id, draft: null, status: receipt });
    expect(await createClientDraft(h.db, owner, client, { ...input, body: "Different request." })).toEqual({ ok: false, error: "request_id_conflict" });
    expect(await deleteOwnEntry(h.db, owner, post.id)).toMatchObject({ ok: true });
    expect(await getClientDraftStatus(h.db, owner, client, made.id)).toEqual({ draftId: made.id, status: "published" });
  });

  it("consumes a client reply draft from the linked browser editor only once", async () => {
    const { action } = await import("~/routes/topic");
    const topic = success(await createTopic(h.db, owner, { body: "The reply destination.", lang: "en" }));
    const made = success(await createClientDraft(h.db, owner, client, { kind: "reply", threadId: topic.id, lang: "en", body }));
    const submit = () => h.outcome(() => action(h.args(h.request(`/t/${topic.id}`, { as: "workflow_owner",
      form: { body, lang: "en", fromDraft: String(made.id), fromDraftVersion: "1" },
    }), { id: String(topic.id) })));
    expect(await submit()).toMatchObject({ status: 302 });
    expect(await submit()).toMatchObject({ status: 409 });
    const [reply] = await h.db.select().from(entries).where(eq(entries.threadId, topic.id));
    expect(await getClientDraftStatus(h.db, owner, client, made.id)).toMatchObject({ status: "published", entryUrl: expect.stringContaining(`#c-${reply.id}`) });
  });

  it("keeps edit proposals private and binds the signed browser approval to the saved proposal", async () => {
    const { action, loader } = await import("~/routes/mcp-entry-edit");
    const topic = success(await createTopic(h.db, owner, { title: "Edit target", body: "Original source text.", lang: "en" }));
    const made = success(await prepareEntryEdit(h.db, owner, client, topic.id, { body }));
    const id = made.proposal.id;
    const path = `/mcp/entry-edits/${id}`;
    const params = { id: String(id) };
    expect(made.proposal).toMatchObject({ status: "pending", version: 1, approvalUrl: expect.stringContaining(path) });
    expect(await prepareEntryEdit(h.db, differentMember, client, topic.id, { body })).toEqual({ ok: false, error: "not_found" });
    expect(await getClientEntryEdit(h.db, owner, otherClient, id)).toBeNull();
    expect(await getClientEntryEdit(h.db, owner, client, id)).toMatchObject({ body, stale: false });
    expect(await discardEntryEdit(h.db, owner, id, 1, otherClient)).toBe(false);
    expect(await h.outcome(() => loader(h.args(h.request(path, { as: "workflow_reader" }), params)))).toMatchObject({ status: 404 });
    expect(await h.outcome(() => loader(h.args(h.request(path, { as: "workflow_owner" }), params)))).toMatchObject({ value: { data: { content: { body }, current: { body: "Original source text." } } } });
    const form = { intent: "apply", entryId: String(topic.id), entryKind: "topic", version: "1", title: "Edit target", body, lang: "en" };
    const request = (fields = form, headers?: Record<string, string>) => h.request(path, { as: "workflow_owner", form: fields, headers });
    const submit = (req: Request) => h.outcome(() => action(h.args(req, params)));
    expect(await submit(request(form, { origin: "https://other.example" }))).toMatchObject({ status: 403 });
    expect(await submit(request({ ...form, body: "Changed hidden field" }))).toMatchObject({ status: 409 });
    const key = await signingCredential(h.db, owner);
    await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, owner));
    try {
      expect(await submit(request())).toMatchObject({ status: 403, value: { data: { error: "signature_required" } } });
      const proof = await attachSigningProof(h.db, owner, request(), key);
      expect(await submit(proof)).toMatchObject({ status: 302, location: `/t/${topic.id}?edited=${topic.id}` });
      expect(await h.db.select().from(memberSignatures).where(eq(memberSignatures.entryId, topic.id))).toMatchObject([{ operation: "edit-topic" }]);
      expect(await getClientEntryEdit(h.db, owner, client, id)).toBeNull();
      expect(await h.db.select({ title: entryEditProposals.title, body: entryEditProposals.body, state: entryEditProposals.state }).from(entryEditProposals)
        .where(eq(entryEditProposals.id, id))).toEqual([{ title: null, body: null, state: "applied" }]);
      expect(await getClientEntryEditStatus(h.db, owner, client, id)).toMatchObject({ status: "applied", version: 2 });
      expect(await h.db.select().from(entries).where(eq(entries.id, topic.id))).toMatchObject([{ body }]);
      await deleteOwnEntry(h.db, owner, topic.id);
      expect(await getClientEntryEditStatus(h.db, owner, client, id)).toEqual({ id, version: 2, status: "applied" });
    } finally {
      await h.db.update(profiles).set({ signPosts: false }).where(eq(profiles.userId, owner));
    }
  });

  it("rejects stale and expired edits, exports current proposals and discards their text", async () => {
    const { action } = await import("~/routes/mcp-entry-edit");
    const topic = success(await createTopic(h.db, owner, { body: "Topic about versions.", lang: "en" }));
    const reply = success(await createReply(h.db, owner, topic.id, { body: "Original reply.", lang: "en" }));
    const made = success(await prepareEntryEdit(h.db, owner, client, reply.id, { body }));
    const id = made.proposal.id;
    expect(await exportOwnEntryEditProposals(h.db, owner, new Date())).toEqual([expect.objectContaining({ id, entry_id: reply.id, body })]);
    expect(await exportOwnEntryEditProposals(h.db, differentMember, new Date())).toEqual([]);
    expect(await editEntry(h.db, owner, reply.id, { body: "A newer manual reply." })).toMatchObject({ ok: true });
    expect(await getClientEntryEdit(h.db, owner, client, id)).toMatchObject({ stale: true });
    const submit = () => h.outcome(() => action(h.args(h.request(`/mcp/entry-edits/${id}`, { as: "workflow_owner",
      form: { intent: "apply", entryId: String(reply.id), entryKind: "reply", version: "1", body, lang: "en" },
    }), { id: String(id) })));
    expect(await submit()).toMatchObject({ status: 409 });
    expect(await discardEntryEdit(h.db, owner, id, 1, client)).toBe(true);
    expect(await submit()).toMatchObject({ status: 409 });
    expect(await getClientEntryEditStatus(h.db, owner, client, id)).toMatchObject({ status: "discarded" });
    const then = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const expired = success(await prepareEntryEdit(h.db, owner, client, reply.id, { body }, then)).proposal.id;
    expect(await getClientEntryEditStatus(h.db, owner, client, expired)).toEqual({ id: expired, status: "unknown" });
    expect(await pruneEntryEditProposals(h.db, new Date())).toBe(1);
    expect(await h.db.select().from(entryEditProposals).where(eq(entryEditProposals.id, expired))).toEqual([]);
    expect(await exportOwnEntryEditProposals(h.db, owner, new Date())).toEqual([]);
  });

  it("requires the owner's same-origin confirmation for the current reply count", async () => {
    const { action } = await import("~/routes/mcp-entry-delete");
    const topic = success(await createTopic(h.db, owner, { body: "A topic to delete.", lang: "en" }));
    const path = `/mcp/entries/${topic.id}/delete`;
    const review = await getEntryDeletionReview(h.db, owner, topic.id);
    if (!review) throw new Error("missing deletion review");
    expect(await prepareEntryDeletion(h.db, differentMember, topic.id)).toBeNull();
    expect(await prepareEntryDeletion(h.db, owner, topic.id)).toMatchObject({ replyCount: 0, replyImpact: "thread_replies_unreadable", approvalUrl: expect.stringContaining(path) });
    const submit = (as: string, count: number, origin?: string) => h.outcome(() => action(h.args(h.request(path, {
      as, form: { confirm: "1", count: String(count), version: review.version }, headers: origin === undefined ? undefined : { origin },
    }), { id: String(topic.id) })));
    expect(await submit("workflow_reader", 0)).toMatchObject({ status: 404 });
    expect(await submit("workflow_owner", 0, "https://other.example")).toMatchObject({ status: 403 });
    await createReply(h.db, differentMember, topic.id, { body: "New reply.", lang: "en" });
    expect(await submit("workflow_owner", 0)).toMatchObject({ status: 409 });
    expect(await submit("workflow_owner", 1)).toMatchObject({ status: 302, location: "/" });
  });
});

describe.skipIf(!REAL_PG_URL)("MCP approval races in PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  const author = "approval-author";
  const reader = "approval-reader";
  beforeAll(async () => {
    scratch = await createScratchDb();
    const db = await scratch.open();
    await addMember(db, author, "approval_author");
    await addMember(db, reader, "approval_reader");
  }, 120_000);
  afterEach(async () => { await scratch?.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); }, 60_000);

  it("serializes creation retries and two updates of the same version", async () => {
    const [first, second] = await Promise.all([scratch.open(), scratch.open()]);
    const input = { kind: "topic", body, lang: "en", requestId: "parallel-create" };
    const [a, b] = await Promise.all([createClientDraft(first, author, client, input), createClientDraft(second, author, client, input)]);
    const id = success(a).id;
    expect(success(b).id).toBe(id);
    expect(await first.select().from(drafts).where(eq(drafts.id, id))).toHaveLength(1);
    expect(await first.select().from(draftReceipts).where(and(eq(draftReceipts.authorId, author), eq(draftReceipts.requestId, input.requestId)))).toHaveLength(1);
    const competing = await Promise.all([
      updateClientDraft(first, author, client, id, { expectedVersion: 1, body: "First alternative." }),
      updateClientDraft(second, author, client, id, { expectedVersion: 1, body: "Second alternative." }),
    ]);
    expect(competing.filter(result => result.ok)).toHaveLength(1);
    expect(competing.filter(result => !result.ok)).toEqual([{ ok: false, error: "draft_conflict" }]);
    expect(await deleteClientDraft(first, author, client, id, 1)).toEqual({ ok: false, error: "draft_conflict" });
    expect(await deleteClientDraft(first, author, client, id, 2)).toEqual({ ok: true });
    expect(await createClientDraft(second, author, client, input)).toMatchObject({ id, draft: null, status: { status: "discarded" } });
  });

  it.each([true, false])("commits one receipt when publish competes with discard (publish first: %s)", async publishFirst => {
    const [db, publication, discard, admin] = await Promise.all([scratch.open(), scratch.open("publish"), scratch.open("discard"), scratch.admin()]);
    const made = success(await createClientDraft(db, author, client, { kind: "topic", lang: "en", body }));
    const blocker = holdTx(db, tx => tx.select().from(drafts).where(eq(drafts.id, made.id)).for("update"));
    const outcomes: Array<ReturnType<typeof publishDraft> | ReturnType<typeof deleteClientDraft>> = [];
    const publish = () => { outcomes.push(publishDraft(publication, author, made.id)); };
    const remove = () => { outcomes.push(deleteClientDraft(discard, author, client, made.id, 1)); };
    try {
      await blocker.ready;
      if (publishFirst) publish(); else remove();
      await waitForLockWait(admin, publishFirst ? "publish" : "discard");
      if (publishFirst) remove(); else publish();
      await waitForLockWait(admin, publishFirst ? "discard" : "publish");
      await blocker.commit();
      const [winner, loser] = await expectSettlesWithin(Promise.all(outcomes), 15_000, "the draft publication and discard");
      expect(winner.ok).toBe(true);
      expect(loser).toEqual({ ok: false, error: "not_found" });
      expect(await getClientDraftStatus(db, author, client, made.id)).toMatchObject({ status: publishFirst ? "published" : "discarded" });
    } finally {
      await blocker.rollback();
      await Promise.allSettled(outcomes);
    }
  }, 35_000);

  it("recounts replies after waiting for a concurrent reply transaction", async () => {
    const [db, replies, deletion, admin] = await Promise.all([scratch.open(), scratch.open(), scratch.open("entry-delete"), scratch.admin()]);
    const topic = success(await createTopic(db, author, { body: "Topic for delete race.", lang: "en" }));
    const review = await getEntryDeletionReview(db, author, topic.id);
    if (!review) throw new Error("missing deletion review");
    const posting = holdTx(replies, tx => createReply(tx, reader, topic.id, { lang: "en", body: "This reply is still committing." }));
    let deleting: ReturnType<typeof confirmEntryDeletion> | undefined;
    try {
      expect(await posting.ready).toMatchObject({ ok: true });
      deleting = confirmEntryDeletion(deletion, author, topic.id, review);
      await waitForLockWait(admin, "entry-delete");
      await posting.commit();
      expect(await deleting).toEqual({ ok: false, error: "delete_conflict" });
      expect(await prepareEntryDeletion(db, author, topic.id)).toMatchObject({ replyCount: 1 });
    } finally {
      await posting.rollback();
      await deleting?.catch(() => {});
    }
  }, 25_000);
});
