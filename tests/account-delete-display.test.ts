import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AuthorLink } from "~/components/author-link";
import { DELETED_MEMBER_HANDLE, DELETED_MEMBER_ID } from "~/lib/deleted-member";
import { deleteAccount } from "~/lib/account-delete.server";
import { entries } from "~/lib/db/schema";
import { getEntryViews } from "~/lib/entries.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { getObservation } from "~/lib/observation.server";
import { m } from "~/paraglide/messages.js";
import { addMember, createTestDb } from "./helpers/db";
import { setTestMessages } from "./stubs/paraglide-messages";
import { jsonMessages } from "./helpers/messages-json";
beforeAll(() => setTestMessages(jsonMessages()));
afterAll(() => setTestMessages());

it("labels retained authors without a member link for members and public readers", () => {
  for (const reader of [false, true]) {
    const html = renderToStaticMarkup(createElement(AuthorLink, { handle: DELETED_MEMBER_HANDLE, reader }));
    expect(html).toBe(m.account_delete_member());
    expect(html).not.toContain("href");
  }
});

it("exposes no old or per-person author identity in retained views, twins or aggregate observation", async () => {
  const db = await createTestDb();
  const ids: number[] = [];
  for (const member of ["one", "two"]) {
    const id = `quit-display-${member}`, handle = `quit_display_${member}`;
    await addMember(db, id, handle);
    const [post] = await db.insert(entries).values({ kind: "topic", authorId: id, body: `Discussion ${member}`, lang: "en" }).returning();
    ids.push(post.id);
    await deleteAccount(db, id, { confirmation: handle });
  }
  const views = await getEntryViews(db, ids);
  for (const id of ids) {
    expect(views.get(id)).toMatchObject({ authorId: DELETED_MEMBER_ID, authorHandle: DELETED_MEMBER_HANDLE });
    const twin = await buildThreadMarkdown(db, id, { page: 1, lang: null, sentences: false, k: null });
    expect(twin).toContain(m.account_delete_member());
    expect(twin).not.toContain("quit_display_");
    expect(twin).not.toContain("quit-display-");
  }
  const observation = await getObservation(db, { model: null });
  expect(observation.accountsDeleted).toBe(2);
  expect(JSON.stringify(observation)).not.toContain("quit-display-");
});

it("labels departed authors in alternative-question and objection panels, lists and Markdown references", async () => {
  const db = await createTestDb();
  await addMember(db, "quit-origin", "quit_origin");
  await addMember(db, "quit-objector", "quit_objector");
  const [origin] = await db.insert(entries).values({ kind: "topic", asksStance: true, authorId: "quit-origin", title: "Original question", body: "Original question", lang: "en" }).returning();
  await db.insert(entries).values([
    { kind: "topic", asksStance: true, altOf: origin.id, authorId: "quit-objector", title: "Alternative question", body: "Alternative question", lang: "en" },
    { kind: "reply", threadId: origin.id, parentId: origin.id, stanceTag: "objection", authorId: "quit-objector", body: "Objection", lang: "en" },
  ]);
  await deleteAccount(db, "quit-objector", { confirmation: "quit_objector" });
  const { loadObjectionPanel, listObjections, listAlternativeRefs, listObjectionRefs } = await import("~/lib/objections.server");
  const opts = { readLangs: ["en"] as const, displayLang: "en" as const };
  for (const result of [await loadObjectionPanel(db, origin.id, opts), await listObjections(db, origin.id, { ...opts, page: 1 })]) {
    expect(result.alternatives).toHaveLength(1); expect(result.objections).toHaveLength(1);
    for (const row of [...result.alternatives, ...result.objections]) expect(row.authorHandle).toBe(DELETED_MEMBER_HANDLE);
  }
  expect((await listAlternativeRefs(db, origin.id))[0].authorHandle).toBe(DELETED_MEMBER_HANDLE);
  expect((await listObjectionRefs(db, origin.id))[0].authorHandle).toBe(DELETED_MEMBER_HANDLE);
  const md = await buildThreadMarkdown(db, origin.id, { page: 1, lang: null, sentences: false, k: null });
  expect(md).not.toContain('author: "@?"');
  expect(md).not.toContain("quit_objector");
});
