import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { parseBlocks } from "./helpers/md";
import { entries } from "~/lib/db/schema";
import { changeVillageMembership, ensureLanguageVillages, listJoinedVillages, topicVillage } from "~/lib/villages.server";
import { action as topicAction } from "~/routes/topic-new";
import { action as draftAction } from "~/routes/draft";
import { createDraft, getDraft } from "~/lib/drafts.server";
import { createApiToken } from "~/lib/tokens.server";
import { createClientDraft } from "~/lib/mcp/drafts.server";
import { handleMcpRequest } from "~/lib/mcp/server.server";
import { getAuth } from "~/lib/auth/auth.server";
import { preserveEditorSource, requiresMarkdownEditor } from "~/lib/rich-editor";

let shared: RouteHarness;
beforeAll(async () => { shared = await setup(); });
beforeEach(() => { vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en"); });
afterAll(() => shared.restore());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en");
  const h = await setupRouteHarness();
  await ensureLanguageVillages(h.db);
  await h.signIn("vfix_actor", { homeArea: "en" });
  await changeVillageMembership(h.db, h.ids.vfix_actor, "ja", "join");
  return h;
}
function watchSelect(db: RouteHarness["db"]) {
  const queries: { toSQL(): { sql: string; params: unknown[] } }[] = [];
  const select = db.select.bind(db);
  vi.spyOn(db, "select").mockImplementation(((...args: Parameters<typeof select>) => {
    const builder = select(...args); const from = builder.from.bind(builder);
    builder.from = ((...args: Parameters<typeof from>) => { const query = from(...args); queries.push(query); return query; }) as typeof builder.from;
    return builder;
  }) as typeof db.select);
  return queries;
}

it("filters the joined-village query by this member without population aggregation", async () => {
  const h = shared;
  await h.signIn("vfix_other", { homeArea: "ja" });
  await changeVillageMembership(h.db, h.ids.vfix_other, "en", "join");
  const queries = watchSelect(h.db);
  expect((await listJoinedVillages(h.db, h.ids.vfix_actor)).map(row => row.slug)).toEqual(["en", "ja"]);
  expect(queries).toHaveLength(1);
  const query = queries[0].toSQL();
  expect(query.params).toContain(h.ids.vfix_actor);
  expect(query.sql).toMatch(/where.*"village_members"\."user_id"\s*=/);
  expect(query.sql).not.toMatch(/count\(|bool_or\(|group by/i);
});

it("requires another submission after resolving differently shaped frontmatter to a different displayed village", async () => {
  const h = shared;
  const existing = (await h.db.select().from(entries)).length;
  const oldForm = await h.outcome(() => topicAction(h.args(h.request("/t/new", { as: "vfix_actor", form: { body: "Old form without display proof.", lang: "en" } }))));
  expect(oldForm.value).toMatchObject({ data: { error: "village_changed", values: { village: "@vfix_actor" } } });
  expect(await h.db.select().from(entries)).toHaveLength(existing);
  for (const declaration of ['"village": ja', "village : ja", "{village: ja}", "village: >-\n  ja"]) {
    const body = `---\n${declaration}\n---\nAn owned reviewed destination.`;
    expect(requiresMarkdownEditor(body)).toBe(true);
    expect(preserveEditorSource(body, body, body)).toBe(body);
    const form = { title: "", body, lang: "en", village: "en", villageExplicit: "0", villageDisplayed: "en" };
    const before = (await h.db.select().from(entries)).length;
    const refused = await h.outcome(() => topicAction(h.args(h.request("/t/new", { as: "vfix_actor", form }))));
    expect(refused.status).toBe(400);
    expect(refused.value).toMatchObject({ data: { error: "village_changed", values: { village: "ja", body } } });
    expect(await h.db.select().from(entries)).toHaveLength(before);
    const accepted = await h.outcome(() => topicAction(h.args(h.request("/t/new", { as: "vfix_actor", form: { ...form, village: "ja", villageDisplayed: "ja" } }))));
    expect(accepted.status).toBe(302);
    const id = Number(/\/t\/(\d+)/.exec(accepted.location!)![1]);
    expect((await topicVillage(h.db, id))?.slug).toBe("ja");
  }
});

it("keeps a refused draft and returns its resolved destination for review before publication", async () => {
  const h = shared;
  const existing = (await h.db.select().from(entries)).length;
  const draft = await createDraft(h.db, h.ids.vfix_actor, { kind: "topic", lang: "en", body: "A reviewed draft.", village: "ja" });
  if (!draft.ok) throw new Error(draft.error);
  const path = `/drafts/${draft.id}`;
  const form = { intent: "publish", body: "A reviewed draft.", lang: "en", village: "ja", villageDisplayed: "en", version: "1" };
  const refused = await h.outcome(() => draftAction(h.args(h.request(path, { as: "vfix_actor", form }), { id: String(draft.id) })));
  expect(refused.status).toBe(400);
  expect(refused.value).toMatchObject({ data: { error: "village_changed", values: { village: "ja", body: form.body, version: "2" } } });
  expect(await getDraft(h.db, h.ids.vfix_actor, draft.id)).not.toBeNull();
  expect(await h.db.select().from(entries)).toHaveLength(existing);
  const version = String((refused.value as { data: { version: number } }).data.version);
  expect((await h.outcome(() => draftAction(h.args(h.request(path, { as: "vfix_actor", form: { ...form, version, villageDisplayed: "ja" } }), { id: String(draft.id) })))).status).toBe(302);
});

it("loads MCP draft-list destinations together and preserves the client boundary", async () => {
  const h = shared;
  const token = await createApiToken(h.db, h.ids.vfix_actor, { name: "List fixture", kind: "draft" });
  if (!token.ok) throw new Error(token.error);
  const client = { key: `token:${token.summary.id}`, id: `token:${token.summary.id}`, name: "List fixture", uri: null, tokenId: token.summary.id };
  for (const village of ["en", "ja", "en"]) expect(await createClientDraft(h.db, h.ids.vfix_actor, client, { kind: "topic", lang: "en", body: "An owned list draft.", village })).toMatchObject({ ok: true });
  await createClientDraft(h.db, h.ids.vfix_actor, { ...client, key: "other-client", tokenId: null }, { kind: "topic", lang: "en", body: "Other client excluded." });
  const auth = await getAuth();
  const queries = watchSelect(h.db);
  const response = await handleMcpRequest(new Request(BASE + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "tomola_draft_list" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tomola_draft_list", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "List fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }), { db: h.db, auth, baseURL: BASE });
  const result = await response.json();
  const rows = JSON.parse(parseBlocks(result.result.content[0].text)[0].body) as { village: string; body: string }[];
  expect(rows.map(row => row.village).sort()).toEqual(["en", "en", "ja"]);
  expect(rows.every(row => row.body === "An owned list draft.")).toBe(true);
  expect(queries.filter(query => /from "drafts"/.test(query.toSQL().sql))).toHaveLength(1);
  expect(queries.filter(query => /from "villages"/.test(query.toSQL().sql))).toHaveLength(0);
});
