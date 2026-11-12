import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createTopic } from "~/lib/entries.server";
import { entries, readingCounts } from "~/lib/db/schema";
import { createApiToken } from "~/lib/tokens.server";
import { serveThreadMd } from "~/lib/md/twin.server";
import { handlePublicMcpRequest } from "~/lib/mcp/server.server";
import { loader as topicLoader } from "~/routes/topic";

let h: RouteHarness;
afterEach(() => { h?.restore(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function seed() {
  h = await setupRouteHarness(); vi.stubEnv("PUBLIC_READING", "1");
  await h.signIn("readingtools"); await h.signIn("readingvisitor");
  const topic = await createTopic(h.db, h.ids.readingtools, { lang: "ja", title: "Reading methods", body: "方法の原文。" });
  if (!topic.ok) throw new Error(topic.error);
  return topic.id;
}
it("counts successful Markdown and token API GETs, excluding HEAD, authors and reply pages", async () => {
  const id = await seed();
  expect((await serveThreadMd(h.request(`/t/${id}.md?lang=en`), String(id))).status).toBe(200);
  const token = await createApiToken(h.db, h.ids.readingvisitor, { name: "Read fixture", kind: "read" });
  if (!token.ok) throw new Error(token.error);
  expect((await serveThreadMd(h.request(`/t/${id}.md?lang=en`, { headers: { authorization: `Bearer ${token.token}` } }), String(id))).status).toBe(200);
  const before = await h.db.select().from(readingCounts);
  expect(before.filter(row => row.count > 0).map(row => row.method).sort()).toEqual(["api", "markdown"]);
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
  const before = await h.db.select().from(readingCounts);
  expect(before.find(row => row.method === "mcp")).toMatchObject({ count: 1, readLang: "en", source: "none" });
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
  const rows = await h.db.select().from(readingCounts);
  expect(rows.filter(row => row.count > 0)).toEqual([{ day: new Date().toISOString().slice(0, 10), method: "ai_crawler", sourceLang: "ja", readLang: "ja", source: "none", count: 1 }]);
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
  const insert = h.db.insert.bind(h.db);
  vi.spyOn(h.db, "insert").mockImplementation(table => {
    if (table === readingCounts) throw new Error(`private entry ${id}, 192.0.2.123, GPTBot/1.0`);
    return insert(table);
  });
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
  expect(warn.mock.calls).toEqual(Array.from({ length: 4 }, () => ["[reading-counts] Could not count read"]));
});
