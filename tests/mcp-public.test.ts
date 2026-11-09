import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createAuth } from "~/lib/auth/auth.server";
import { entries, profiles, translations, villages, drafts, notifications } from "~/lib/db/schema";
import { createTopic, createReply } from "~/lib/entries.server";
import { createGlossaryEntry, deleteGlossaryEntry } from "~/lib/glossary.server";
import { createDraft } from "~/lib/drafts.server";
import { createApiToken } from "~/lib/tokens.server";
import { handleMcpRequest, handlePublicMcpRequest } from "~/lib/mcp/server.server";
import { buildGlossaryMarkdown } from "~/lib/md/glossary.server";
import { mcpMarkdown, PRIVATE_RECORDS_RESPONSE } from "~/lib/mcp/output.server";
import { NO_SCOPE } from "~/lib/roles.server";
import { hitIpLimit, clearMemoryReadLimitsForTests, READ_RATE_LIMIT } from "~/lib/rate-limit.server";
import { addMember, createTestDb } from "./helpers/db";

const baseURL = "https://forum.example.org";
let db: Awaited<ReturnType<typeof createTestDb>>;
let auth: ReturnType<typeof createAuth>;
let readToken: string;
let draftToken: string;
let topicId: number;
let hiddenId: number;
let closedId: number;
let deletedId: number;

function request(method: string, params: object = {}, options: { member?: boolean; token?: string; legacy?: boolean; headers?: Record<string, string> } = {}) {
  return new Request(`${baseURL}/mcp${options.member ? "" : "/public"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "192.0.2.40",
      ...(options.legacy ? {} : { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(method === "tools/call" ? { "Mcp-Name": (params as { name: string }).name } : {}) }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: options.legacy ? params : {
      ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "Public fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} },
    } }),
  });
}
async function rpcBody(response: Response) {
  const text = await response.text();
  return JSON.parse(response.headers.get("content-type")?.includes("text/event-stream") ? /^data: (.+)$/m.exec(text)![1] : text);
}
const publicRpc = (method: string, params: object = {}, options: Parameters<typeof request>[2] = {}) => handlePublicMcpRequest(request(method, params, options), { db, baseURL });
const publicCall = (name: string, args: object = {}, options: Parameters<typeof request>[2] = {}) => publicRpc("tools/call", { name, arguments: args }, options);
const memberCall = (name: string, args: object = {}, token = readToken) => handleMcpRequest(request("tools/call", { name, arguments: args }, { member: true, token }), { db, auth, baseURL });

beforeAll(async () => {
  db = await createTestDb();
  await addMember(db, "reader", "public_fixture", { readLangs: ["ja"] });
  await db.update(profiles).set({ displayLang: "ja", uiLocale: "ja" }).where(eq(profiles.userId, "reader"));
  auth = createAuth(db, { baseURL, secret: "fictional-public-test-secret-0123456789", sendMagicLink: async () => {} });
  for (const kind of ["read", "draft"] as const) {
    const token = await createApiToken(db, "reader", { kind, name: `${kind} fixture` });
    if (!token.ok) throw new Error(token.error);
    if (kind === "read") readToken = token.token; else draftToken = token.token;
  }
  const topic = async (title: string, body: string) => {
    const result = await createTopic(db, "reader", { lang: "ja", title, body });
    if (!result.ok) throw new Error(result.error);
    return result.id;
  };
  topicId = await topic("PUBLIC-TITLE", "PUBLIC-BODY");
  const [source] = await db.select().from(entries).where(eq(entries.id, topicId));
  await db.insert(translations).values({ entryId: topicId, field: "body", lang: "en", kind: "primary", text: "SITE-DEFAULT-TRANSLATION", sourceHash: source.sourceHash, engine: "fake", model: "fake-1" });
  hiddenId = await topic("HIDDEN-TITLE", "HIDDEN-BODY");
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hiddenId));
  const reply = await createReply(db, "reader", topicId, { lang: "en", body: "HIDDEN-REPLY" });
  if (!reply.ok) throw new Error(reply.error);
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, reply.id));
  deletedId = await topic("DELETED-TITLE", "DELETED-BODY");
  await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, deletedId));
  closedId = await topic("CLOSED-TITLE", "CLOSED-BODY");
  const [village] = await db.insert(villages).values({ slug: "closed-fixture", kind: "closed", name: "Closed fixture" }).returning();
  await db.update(entries).set({ villageId: village.id }).where(eq(entries.id, closedId));
  const actor = { userId: "reader", scope: { operator: true, langs: [] } };
  await createGlossaryEntry(db, actor, { term: "MEMBER-GLOSSARY", lang: "en", targetLang: "ja", candidates: "会員用語" });
  const deleted = await createGlossaryEntry(db, actor, { term: "DELETED-GLOSSARY", lang: "en", targetLang: "ja" });
  if (!deleted.ok) throw new Error("glossary fixture");
  await deleteGlossaryEntry(db, actor, deleted.id);
  await createDraft(db, "reader", { kind: "topic", lang: "en", body: "MEMBER-ONLY-DRAFT" });
});
beforeEach(() => {
  vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en"); vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("BETTER_AUTH_URL", baseURL);
  clearMemoryReadLimitsForTests(db);
});
afterEach(() => vi.unstubAllEnvs());

describe("anonymous MCP", () => {
  it("initializes without authentication and lists exactly three read-only tools in both protocol versions", async () => {
    const initialized = await publicRpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Fixture", version: "1" } }, { legacy: true });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("x-ratelimit-remaining")).toBe(String(READ_RATE_LIMIT.limit - 1));
    expect(initialized.headers.get("www-authenticate")).toBeNull();
    const info = (await rpcBody(initialized)).result;
    expect(info.instructions).toContain(`${baseURL}/mcp`);
    expect(info.instructions).toContain(`${baseURL}/llms.txt#accounts`);
    for (const legacy of [false, true]) {
      const response = await publicRpc("tools/list", {}, { legacy });
      expect(response.status).toBe(200);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const tools = (await rpcBody(response)).result.tools;
      expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["tomola_latest", "tomola_privacy", "tomola_thread"]);
      expect(tools.every((tool: { annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint)).toBe(true);
    }
  });

  it("rejects every member-only tool as unknown without authentication challenges or writes", async () => {
    const before = await db.select().from(drafts);
    const privateNotifications = await db.select().from(notifications);
    for (const name of ["tomola_glossary", "tomola_search", "tomola_activity", "tomola_stance_counts", "tomola_draft_create", "tomola_draft_list", "tomola_draft_get", "tomola_draft_update", "tomola_draft_delete"]) {
      const response = await publicCall(name, { id: topicId, kind: "topic", body: "ATTEMPTED-WRITE" }, { token: readToken, headers: { cookie: "better-auth.session_token=ignored" } });
      expect(response.status).not.toBe(401); expect(response.status).not.toBe(403);
      expect(response.headers.get("www-authenticate")).toBeNull();
      const output = await response.json();
      expect(output.error).toMatchObject({ code: -32602 });
      expect(output.error.message).toContain(`Tool ${name} not found`);
      expect(JSON.stringify(output)).not.toMatch(/MEMBER-ONLY-DRAFT|MEMBER-GLOSSARY|public_fixture/);
    }
    expect(await db.select().from(drafts)).toEqual(before);
    expect(await db.select().from(notifications)).toEqual(privateNotifications);
    expect((await publicCall("tomola_latest")).status).toBe(200);
  });

  it("withholds hidden text and closed villages in thread and latest reads, including when credentials are supplied", async () => {
    for (const options of [{}, { token: readToken }, { headers: { cookie: "better-auth.session_token=ignored", "accept-language": "en" } }]) {
      const latest = JSON.stringify(await (await publicCall("tomola_latest", {}, options)).json());
      expect(latest).toContain("PUBLIC-TITLE");
      expect(latest).not.toMatch(/HIDDEN-TITLE|CLOSED-TITLE|DELETED-TITLE|MEMBER-ONLY-DRAFT/);
      const body = JSON.stringify(await (await publicCall("tomola_thread", { id: topicId, lang: "all" }, options)).json());
      expect(body).toContain("PUBLIC-BODY"); expect(body).not.toContain("HIDDEN-REPLY");
      for (const id of [hiddenId, closedId, deletedId]) {
        const text = JSON.stringify(await (await publicCall("tomola_thread", { id }, options)).json());
        expect(text).not.toMatch(/HIDDEN-BODY|CLOSED-BODY|CLOSED-TITLE|DELETED-BODY/);
      }
    }
  });

  it("uses the site language for anonymous reads and keeps the member preference", async () => {
    const anonymous = JSON.stringify(await (await publicCall("tomola_thread", { id: topicId })).json());
    expect(anonymous).toContain("SITE-DEFAULT-TRANSLATION");
    const member = JSON.stringify(await (await memberCall("tomola_thread", { id: topicId })).json());
    expect(member).toContain("PUBLIC-BODY"); expect(member).not.toContain("SITE-DEFAULT-TRANSLATION");
    const explicit = JSON.stringify(await (await publicCall("tomola_thread", { id: topicId, lang: "ja" })).json());
    expect(explicit).not.toContain("SITE-DEFAULT-TRANSLATION");
  });

  it("keeps glossary listing and reading on the member endpoint, with only the fixed privacy notice public", async () => {
    const list = await handleMcpRequest(request("tools/list", {}, { member: true, token: readToken }), { db, auth, baseURL });
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools.map((tool: { name: string }) => tool.name)).toContain("tomola_glossary");
    const glossaryResponse = await memberCall("tomola_glossary");
    expect(glossaryResponse.status).toBe(200);
    const glossary = (await glossaryResponse.json()).result;
    expect(glossary).toMatchObject(mcpMarkdown(await buildGlossaryMarkdown(db, { userId: "reader", scope: NO_SCOPE }, { from: null, to: null, page: 1, deleted: false, k: null })));
    expect(JSON.stringify(glossary)).toContain("MEMBER-GLOSSARY");
    expect(JSON.stringify(glossary)).toContain("@public_fixture");
    expect(JSON.stringify(glossary)).not.toContain("DELETED-GLOSSARY");
    expect((await (await publicCall("tomola_privacy")).json()).result.content[0].text).toContain(PRIVATE_RECORDS_RESPONSE);
    const created = await memberCall("tomola_draft_create", { kind: "topic", lang: "en", body: "MEMBER-CLIENT-DRAFT" }, draftToken);
    expect(created.status).toBe(200);
    expect((await created.json()).result.isError).not.toBe(true);
    expect(JSON.stringify(await (await memberCall("tomola_draft_list", {}, draftToken)).json())).toContain("MEMBER-CLIENT-DRAFT");
    expect(JSON.stringify(await (await publicCall("tomola_latest")).json())).not.toContain("MEMBER-CLIENT-DRAFT");
  });

  it("disables public MCP when public reading is closed and still requires authentication on the member endpoint", async () => {
    vi.stubEnv("PUBLIC_READING", "");
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      const response = await publicRpc(method);
      expect(response.status).toBe(404); expect(response.headers.get("www-authenticate")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "public_reading_disabled" });
    }
    const member = await handleMcpRequest(request("tools/list", {}, { member: true }), { db, auth, baseURL });
    expect(member.status).toBe(401); expect(member.headers.get("www-authenticate")).toContain("/oauth-protected-resource/mcp");
  });

  it("shares the anonymous IP allowance, counts protocol requests and failures, and isolates addresses", async () => {
    const headers = new Headers({ "x-forwarded-for": "192.0.2.40" });
    for (let i = 0; i < READ_RATE_LIMIT.limit - 2; i++) await hitIpLimit(db, headers, "public-read");
    const list = await publicRpc("tools/list");
    expect(list.status).toBe(200); expect(list.headers.get("x-ratelimit-remaining")).toBe("1");
    const unknown = await publicCall("tomola_draft_create");
    expect(unknown.headers.get("x-ratelimit-remaining")).toBe("0");
    const denied = await publicRpc("tools/list");
    expect(denied.status).toBe(429); expect(denied.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(denied.headers.get("www-authenticate")).toBeNull();
    expect(denied.headers.get("x-ratelimit-limit")).toBe(String(READ_RATE_LIMIT.limit));
    expect((await publicRpc("tools/list", {}, { headers: { "x-forwarded-for": "192.0.2.41" } })).status).toBe(200);
    expect((await hitIpLimit(db, headers, "public-read"))?.allowed).toBe(false);
  });

  it("rejects foreign hosts, browser origins and non-POST methods without authentication discovery", async () => {
    for (const [request, status] of [
      [new Request(`${baseURL}/mcp/public`), 405],
      [new Request(`${baseURL}/mcp/public`, { method: "DELETE" }), 405],
      [new Request("https://attacker.example/mcp/public", { method: "POST" }), 403],
      [new Request(`${baseURL}/mcp/public`, { method: "POST", headers: { origin: "https://attacker.example" } }), 403],
    ] as const) {
      const response = await handlePublicMcpRequest(request, { db, baseURL });
      expect(response.status).toBe(status); expect(response.headers.get("www-authenticate")).toBeNull();
    }
  });
});
