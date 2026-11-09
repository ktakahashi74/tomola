import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createReply, createTopic } from "~/lib/entries.server";
import { entries, entryRevisions, jobs, memberSignatures, profiles, translations } from "~/lib/db/schema";
import { previewSignedWrite } from "~/lib/signing.server";
import { buildManifest } from "~/lib/md/manifest.server";
import { buildMemberExport } from "~/lib/exports.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { attachSigningProof, signingCredential } from "./helpers/signing";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("source_corrector"); });
afterAll(() => h.restore());

it.each([false, true])("corrects topic and reply languages through the real author routes with signing %s", async signPosts => {
  const userId = h.ids.source_corrector;
  await h.db.update(profiles).set({ signPosts }).where(eq(profiles.userId, userId));
  const key = signPosts ? await signingCredential(h.db, userId) : null;
  const topic = await createTopic(h.db, userId, { title: "Existing title", body: "Existing body", lang: "ja" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, userId, topic.id, { body: "Existing reply", lang: "ja" });
  if (!reply.ok) throw new Error(reply.error);
  for (const [kind, id, body] of [["topic", topic.id, "Existing body"], ["reply", reply.id, "Existing reply"]] as const) {
    const manifestBefore = (await buildManifest(h.db, { after: 0, k: null })).topics.find(t => t.id === `p-${topic.id}`)!.content_hash;
    const [before] = await h.db.select().from(entries).where(eq(entries.id, id));
    await h.db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "human", text: "Discard this translation", sourceHash: before.sourceHash });
    await h.db.update(entries).set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where(eq(entries.id, id));
    const path = `/${kind === "topic" ? "t" : "c"}/${id}/edit`;
    let request = h.request(path, { as: "source_corrector", form: { ...(kind === "topic" ? { title: "Existing title" } : {}), body, lang: "en" } });
    const preview = await previewSignedWrite(h.db, userId, path, await request.clone().formData());
    expect(preview.content.lang).toBe("en");
    if (key) request = await attachSigningProof(h.db, userId, request, key);
    const route = kind === "topic" ? await import("~/routes/topic-edit") : await import("~/routes/reply-edit");
    expect(await h.outcome(() => route.action(h.args(request, { id: String(id) })))).toMatchObject({ status: 302 });
    expect((await h.db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ lang: "en", body, mentionRevision: 1 });
    expect((await buildManifest(h.db, { after: 0, k: null })).topics.find(t => t.id === `p-${topic.id}`)!.content_hash).not.toBe(manifestBefore);
    expect(await h.db.select().from(entryRevisions).where(eq(entryRevisions.entryId, id))).toHaveLength(1);
    expect(await h.db.select().from(translations).where(eq(translations.entryId, id))).toEqual([]);
    const work = (await h.db.select().from(jobs).where(and(eq(jobs.kind, "translate_entry"), eq(jobs.status, "queued")))).filter(j => (j.payload as { entryId: number }).entryId === id);
    expect(work.length).toBeGreaterThan(0);
    expect(work.every(j => (j.payload as { lang: string }).lang !== "en")).toBe(true);
    const records = await h.db.select().from(memberSignatures).where(eq(memberSignatures.entryId, id));
    expect(records).toHaveLength(signPosts ? 1 : 0);
    if (signPosts) expect(JSON.parse(records[0].payload).input).toMatchObject({ lang: "en", body });
  }
  if (key) {
    const [previous] = await h.db.select().from(memberSignatures).where(eq(memberSignatures.entryId, topic.id));
    const request = await attachSigningProof(h.db, userId, h.request(`/t/${topic.id}/edit`, { as: "source_corrector", form: { title: "Existing title", body: "Existing body", lang: "ja" } }), key);
    const route = await import("~/routes/topic-edit");
    expect(await h.outcome(() => route.action(h.args(request, { id: String(topic.id) })))).toMatchObject({ status: 302 });
    const exported = (await buildMemberExport(h.db, userId)).entries.find(e => e.id === topic.id)!;
    expect(exported.signature_ids).not.toContain(previous.id);
    expect(exported.revisions.flatMap(r => r.signature_ids)).toContain(previous.id);
  }
});

it.each([false, true])("edits topic and reply bodies without changing their closed language with signing %s", async signPosts => {
  const userId = h.ids.source_corrector;
  await h.db.update(profiles).set({ signPosts }).where(eq(profiles.userId, userId));
  const key = signPosts ? await signingCredential(h.db, userId) : null;
  vi.stubEnv("ENABLED_LANGS", "ja,en,vi");
  try {
    const topic = await createTopic(h.db, userId, { title: "Existing title", body: "Existing body", lang: "vi" });
    if (!topic.ok) throw new Error(topic.error);
    const reply = await createReply(h.db, userId, topic.id, { body: "Existing reply", lang: "vi" });
    if (!reply.ok) throw new Error(reply.error);
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    for (const [kind, id] of [["topic", topic.id], ["reply", reply.id]] as const) {
      await h.db.update(entries).set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where(eq(entries.id, id));
      const path = `/${kind === "topic" ? "t" : "c"}/${id}/edit`;
      const body = `Corrected ${kind} body`;
      let request = h.request(path, { as: "source_corrector", form: { ...(kind === "topic" ? { title: "Existing title" } : {}), body, lang: "vi" } });
      const preview = await previewSignedWrite(h.db, userId, path, await request.clone().formData());
      expect(preview.content.lang).toBe("vi");
      if (key) request = await attachSigningProof(h.db, userId, request, key);
      const route = kind === "topic" ? await import("~/routes/topic-edit") : await import("~/routes/reply-edit");
      expect(await h.outcome(() => route.action(h.args(request, { id: String(id) })))).toMatchObject({ status: 302 });
      expect((await h.db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ lang: "vi", body, mentionRevision: 1 });
      expect(await h.db.select().from(entryRevisions).where(eq(entryRevisions.entryId, id))).toHaveLength(1);
      const signatures = await h.db.select().from(memberSignatures).where(eq(memberSignatures.entryId, id));
      expect(signatures).toHaveLength(signPosts ? 1 : 0);
      if (signPosts) expect(JSON.parse(signatures[0].payload).input).toMatchObject({ lang: "vi", body });
    }
  } finally { vi.unstubAllEnvs(); }
});
