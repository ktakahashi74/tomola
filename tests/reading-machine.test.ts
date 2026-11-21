import { afterEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createTopic } from "~/lib/entries.server";
import { entries, entryReadingCounts, readingCounts, translations } from "~/lib/db/schema";
import { createApiToken } from "~/lib/tokens.server";
import { serveThreadMd } from "~/lib/md/twin.server";
import { handlePublicMcpRequest } from "~/lib/mcp/server.server";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { loader as topicLoader } from "~/routes/topic";

let h: RouteHarness;
afterEach(() => { h?.restore(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setTestLocale("en"); });
async function seed() {
  h = await setupRouteHarness(); vi.stubEnv("PUBLIC_READING", "1");
  setTestLocale("en");
  await h.signIn("readingtools"); await h.signIn("readingvisitor");
  const topic = await createTopic(h.db, h.ids.readingtools, { lang: "ja", title: "Reading methods", body: "方法の原文。" });
  if (!topic.ok) throw new Error(topic.error);
  return topic.id;
}
async function seedPrivateArticleTotal(id: number) {
  await h.db.insert(entryReadingCounts).values({
    entryId: id, day: new Date().toISOString().slice(0, 10), method: "browser", isTranslated: false, count: 918273,
  });
}
async function insertTranslation(id: number) {
  const [source] = await h.db.select().from(entries).where(eq(entries.id, id));
  await h.db.insert(translations).values({
    entryId: id, lang: "en", field: "body", kind: "primary", sourceHash: source.sourceHash, engine: "fake", text: "The translated reading fixture.",
  });
}
it("counts successful Markdown and token API GETs, excluding HEAD, authors and reply pages", async () => {
  const id = await seed();
  expect((await serveThreadMd(h.request(`/t/${id}.md?lang=en`), String(id))).status).toBe(200);
  await seedPrivateArticleTotal(id);
  const token = await createApiToken(h.db, h.ids.readingvisitor, { name: "Read fixture", kind: "read" });
  if (!token.ok) throw new Error(token.error);
  expect((await serveThreadMd(h.request(`/t/${id}.md?lang=en`, { headers: { authorization: `Bearer ${token.token}` } }), String(id))).status).toBe(200);
  await insertTranslation(id);
  for (const headers of [{}, { authorization: `Bearer ${token.token}` }] as Record<string, string>[]) {
    const response = await serveThreadMd(h.request(`/t/${id}.md?lang=en`, { headers }), String(id));
    const body = await response.text();
    expect(body).toContain("The translated reading fixture.");
    expect(body).not.toContain("918273");
  }
  const before = await h.db.select().from(readingCounts);
  expect((await h.db.select().from(entryReadingCounts)).filter(row => row.method !== "browser").map(row => [row.method, row.isTranslated, row.count]).sort()).toEqual([
    ["api", false, 1], ["api", true, 1], ["markdown", false, 1], ["markdown", true, 1],
  ]);
  await serveThreadMd(new Request(h.request(`/t/${id}.md?lang=en`), { method: "HEAD" }), String(id));
  await serveThreadMd(h.request(`/t/${id}.md?lang=en`, { as: "readingtools" }), String(id));
  await h.db.insert(entries).values(Array.from({ length: 101 }, () => ({ kind: "reply", threadId: id, authorId: h.ids.readingtools, lang: "ja", body: "Reply page" })));
  expect((await serveThreadMd(h.request(`/t/${id}.md?page=2&lang=en`), String(id))).status).toBe(200);
  expect(await h.db.select().from(readingCounts)).toEqual(before);
});
it("counts public MCP article reads once without counting missing or hidden content", async () => {
  const id = await seed();
  const read = () => handlePublicMcpRequest(new Request("http://localhost:5173/mcp/public", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "tomola_thread" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tomola_thread", arguments: { id, lang: "en" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "Reading fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }), { db: h.db, baseURL: "http://localhost:5173" });
  const response = await read();
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("方法の原文。");
  await insertTranslation(id);
  await seedPrivateArticleTotal(id);
  const translated = await (await read()).text();
  expect(translated).toContain("The translated reading fixture.");
  expect(translated).not.toContain("918273");
  const before = await h.db.select().from(readingCounts);
  expect(before.find(row => row.method === "mcp" && row.readLang === "ja")).toMatchObject({ count: 1, source: "none" });
  expect((await h.db.select().from(entryReadingCounts)).filter(row => row.method === "mcp").map(row => [row.isTranslated, row.count]).sort()).toEqual([[false, 1], [true, 1]]);
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, id));
  await read();
  expect(await h.db.select().from(readingCounts)).toEqual(before);
});
it("counts declared AI crawlers on article HTML only, excluding ordinary bots, prefetches and data loads", async () => {
  const id = await seed();
  for (const [path, agent, purpose] of [
    [`/t/${id}?lang=ja`, "GPTBot/1.0", ""], [`/t/${id}?lang=ja`, "Googlebot/2.1", ""],
    [`/t/${id}?lang=ja`, "ClaudeBot/1.0", "prefetch"], [`/t/${id}.data?lang=ja`, "GPTBot/1.0", ""],
  ]) await topicLoader(h.args(h.request(path, { headers: { "user-agent": agent, purpose } }), { id: String(id) }));
  await insertTranslation(id);
  await topicLoader(h.args(h.request(`/t/${id}?lang=en&tr=${id}`, { headers: { "user-agent": "GPTBot/1.0" } }), { id: String(id) }));
  expect((await h.db.select().from(entryReadingCounts)).map(row => [row.method, row.isTranslated, row.count]).sort()).toEqual([
    ["ai_crawler", false, 1], ["ai_crawler", true, 1],
  ]);
});

it("excludes non-AI robots from Markdown counts while retaining AI and ordinary readers", async () => {
  const id = await seed();
  for (const agent of ["Googlebot/2.1", "bingbot/2.0", "DuckDuckBot/1.0", "Slurp"]) {
    expect((await serveThreadMd(h.request(`/t/${id}.md?lang=ja`, { headers: { "user-agent": agent } }), String(id))).status).toBe(200);
  }
  expect((await h.db.select().from(readingCounts)).every(row => row.count === 0)).toBe(true);
  for (const agent of ["GPTBot/1.0", "Meta-ExternalFetcher/1.0", "MistralAI-User/1.0", "DuckAssistBot/1.0", "Mozilla/5.0"]) {
    expect((await serveThreadMd(h.request(`/t/${id}.md?lang=ja`, { headers: { "user-agent": agent } }), String(id))).status).toBe(200);
  }
  expect((await h.db.select().from(readingCounts)).filter(row => row.count > 0)).toEqual([
    { day: new Date().toISOString().slice(0, 10), method: "markdown", sourceLang: "ja", readLang: "ja", source: "none", count: 5 },
  ]);
});
it("serves crawler HTML, Markdown, API and MCP despite counter write failures and logs no identifiers", async () => {
  const id = await seed();
  const token = await createApiToken(h.db, h.ids.readingvisitor, { name: "Failure fixture", kind: "read" });
  if (!token.ok) throw new Error(token.error);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await h.db.execute(sql`alter table entry_reading_counts add constraint fixture_reject_machine_read check (count = 0)`);
  const html = await topicLoader(h.args(h.request(`/t/${id}?lang=ja`, { headers: { "user-agent": "GPTBot/1.0" } }), { id: String(id) }));
  expect(html).toHaveProperty("topic.id", id);
  for (const headers of [{}, { authorization: `Bearer ${token.token}` }] as Record<string, string>[]) {
    const response = await serveThreadMd(h.request(`/t/${id}.md?lang=ja`, { headers }), String(id));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("方法の原文。");
  }
  const response = await handlePublicMcpRequest(new Request("http://localhost:5173/mcp/public", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "tomola_thread" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tomola_thread", arguments: { id, lang: "ja" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "Failure fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }), { db: h.db, baseURL: "http://localhost:5173" });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("方法の原文。");
  expect((await h.db.select().from(readingCounts)).every(row => row.count === 0)).toBe(true);
  expect(warn.mock.calls).toEqual(Array.from({ length: 4 }, () => ["[reading-counts] Could not count read"]));
});
