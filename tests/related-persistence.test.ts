import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { drafts, entries, entryReferences, entryRevisions, profiles } from "~/lib/db/schema";
import { createDraft, publishDraft } from "~/lib/drafts.server";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
let target: number, holder: number, sequence = 0;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("reference_writer", { homeArea: "en", readLangs: ["en"] });
  const a = await createTopic(h.db, h.ids.reference_writer, { lang: "en", title: "Reference destination", body: "Target" });
  const b = await createTopic(h.db, h.ids.reference_writer, { lang: "en", title: "Reply holder", body: "Holder" });
  if (!a.ok || !b.ok) throw new Error("fixture failed");
  target = a.id; holder = b.id;
});
afterAll(() => h.restore());

const paths = ["topic", "reply", "edit", "draft-topic", "draft-reply", "signed-topic", "signed-reply"] as const;
type Path = typeof paths[number];
async function prepare(path: Path, failure = false) {
  const body = `${failure ? "Reject index" : "Accept index"} ${++sequence}: [discussion](/t/${target}?k=private)`;
  let initial: number | undefined;
  if (path === "edit") {
    const result = await createTopic(h.db, h.ids.reference_writer, { lang: "en", title: "Original edit", body: `Original [link](/t/${holder})` });
    if (!result.ok) throw new Error(result.error);
    initial = result.id;
  }
  if (path.startsWith("draft")) {
    const result = await createDraft(h.db, h.ids.reference_writer, { kind: path === "draft-topic" ? "topic" : "reply", threadId: path === "draft-reply" ? holder : null, lang: "en", title: "Draft reference", body });
    if (!result.ok) throw new Error(result.error);
    initial = result.id;
  }
  const run = async () => {
    if (path === "topic") return createTopic(h.db, h.ids.reference_writer, { lang: "en", title: "New reference", body });
    if (path === "reply") return createReply(h.db, h.ids.reference_writer, holder, { lang: "en", body });
    if (path === "edit") return editEntry(h.db, h.ids.reference_writer, initial!, { title: "Changed reference", body });
    if (path.startsWith("draft")) return publishDraft(h.db, h.ids.reference_writer, initial!);
    await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, h.ids.reference_writer));
    try {
      const reply = path === "signed-reply";
      const url = reply ? `/t/${holder}` : "/t/new";
      const mod = reply ? await import("~/routes/topic") : await import("~/routes/topic-new");
      const args = await h.signedArgs(h.request(url, { as: "reference_writer", form: { title: "Signed reference", lang: "en", body } }), reply ? { id: String(holder) } : {});
      expect(await h.outcome(() => mod.action(args))).toMatchObject({ status: 302 });
      const [entry] = await h.db.select({ id: entries.id }).from(entries).where(eq(entries.body, body));
      return { ok: true, id: entry.id };
    } finally { await h.db.update(profiles).set({ signPosts: false }).where(eq(profiles.userId, h.ids.reference_writer)); }
  };
  return { run, body, initial };
}

it.each(paths)("synchronizes the index when publishing through %s", async path => {
  const prepared = await prepare(path);
  const result = await prepared.run();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("publication failed");
  expect(await h.db.select().from(entryReferences).where(eq(entryReferences.sourceEntryId, result.id))).toEqual([{ sourceEntryId: result.id, targetEntryId: target }]);
  expect((await h.db.select().from(entries).where(eq(entries.id, result.id)))[0].body).toBe(prepared.body);
});

it.each(paths)("rolls back the body, reference index and publication state if %s indexing fails", async path => {
  const prepared = await prepare(path, true);
  const beforeEntries = await h.db.select().from(entries);
  const beforeRefs = await h.db.select().from(entryReferences);
  const beforeDrafts = await h.db.select().from(drafts);
  const beforeRevisions = await h.db.select().from(entryRevisions);
  await h.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION reject_reference_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF EXISTS (SELECT 1 FROM entries WHERE id = NEW.source_entry_id AND body LIKE 'Reject index%') THEN RAISE EXCEPTION 'fixture index failure'; END IF; RETURN NEW; END $$;`));
  await h.db.execute(sql.raw("CREATE TRIGGER reject_reference_fixture BEFORE INSERT ON entry_references FOR EACH ROW EXECUTE FUNCTION reject_reference_fixture();"));
  try {
    await expect(prepared.run()).rejects.toThrow();
    expect(await h.db.select().from(entries)).toEqual(beforeEntries);
    expect(await h.db.select().from(entryReferences)).toEqual(beforeRefs);
    expect(await h.db.select().from(drafts)).toEqual(beforeDrafts);
    expect(await h.db.select().from(entryRevisions)).toEqual(beforeRevisions);
  } finally {
    await h.db.execute(sql.raw("DROP TRIGGER reject_reference_fixture ON entry_references;"));
    await h.db.execute(sql.raw("DROP FUNCTION reject_reference_fixture();"));
  }
});
