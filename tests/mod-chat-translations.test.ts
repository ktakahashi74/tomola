import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chatAccessLog, chatMessages, chatTranslationReports, roles, villages } from "~/lib/db/schema";
import { loader, action } from "~/routes/mod-chat-translations";
import { chatSourceHash } from "~/lib/village-chat-translations.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
let h: RouteHarness, id: number, messageId: string;
beforeAll(async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  h = await setupRouteHarness();
  for (const handle of ["qroute_author", "qroute_reader", "qroute_mod"]) await h.signIn(handle);
  await h.db.insert(roles).values({ userId: h.ids.qroute_mod, role: "moderator", lang: "en" });
  const [village] = await h.db.insert(villages).values({ kind: "closed" }).returning();
  const [message] = await h.db.insert(chatMessages).values({ villageId: village.id, authorId: h.ids.qroute_author, lang: "ja", body: "私的な原文。", createdSeq: 1, changedSeq: 1 }).returning();
  messageId = message.id;
  const [report] = await h.db.insert(chatTranslationReports).values({ messageId, reporterId: h.ids.qroute_reader, lang: "en", sourceLang: "ja", original: message.body, translation: "Private translation", note: "Private note", sourceHash: chatSourceHash(message.body), translationHash: chatSourceHash("Private translation"), status: "open", createdSeq: 1, changedSeq: 1 }).returning();
  id = report.id;
});
afterAll(() => { h?.restore(); vi.unstubAllEnvs(); });
it("returns only case metadata before the audited POST evidence read", async () => {
  const page = await loader(h.args(h.request(`/mod/chat-translations?id=${id}`, { as: "qroute_mod" })));
  const text = JSON.stringify(page);
  for (const secret of [messageId, h.ids.qroute_author, "私的な原文。", "Private translation", "Private note"]) expect(text).not.toContain(secret);
  expect(await h.db.select().from(chatAccessLog)).toHaveLength(0);
  const opened = await action(h.args(h.request(`/mod/chat-translations?id=${id}`, { as: "qroute_mod", form: { id: String(id), intent: "open" } })));
  expect(JSON.stringify(opened)).toContain("私的な原文。");
  expect(await h.db.select().from(chatAccessLog)).toHaveLength(1);
});
it("preserves the shared not-found response for malformed case IDs", async () => {
  expect(await h.outcome(() => loader(h.args(h.request('/mod/chat-translations?id=invalid', { as: "qroute_mod" }))))).toMatchObject({ status: 404 });
});
