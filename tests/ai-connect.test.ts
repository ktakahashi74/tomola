import { withShellLabels } from "./helpers/render-in-router";
import { shellLabels } from "~/lib/shell-labels.server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, useLoaderData, type StaticHandlerContext } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteFooter } from "~/components/site-footer";
import { accountsPointer, accountsSection, clientSetupMarkdown, connectMarkdown, connectPlan, connectPointer, mcpServerName, shellQuote } from "~/lib/api/connect.server";
import { mcpConnectionGuide } from "~/lib/mcp/guide.server";
import { m } from "~/paraglide/messages.js";
import { setTestLocale } from "./stubs/paraglide-runtime";

const mocks = vi.hoisted(() => ({ session: vi.fn(), db: vi.fn(), connections: vi.fn() }));
vi.mock("~/lib/auth/session.server", () => ({ getSessionUser: mocks.session }));
vi.mock("~/lib/db/client.server", () => ({ getDb: mocks.db }));
vi.mock("~/lib/mcp/connections.server", () => ({ listConnections: mocks.connections }));
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue(null); mocks.db.mockResolvedValue({}); mocks.connections.mockResolvedValue([]); });
afterEach(() => { vi.unstubAllEnvs(); setTestLocale("en"); });
const BASE = "http://localhost:5173";
const args = (path: string) => ({ request: new Request(`${BASE}${path}`), params: {}, context: {} }) as never;
const render = async (lang: "en" | "ja" = "en") => {
  setTestLocale(lang);
  const route = await import("~/routes/connect");
  const routes = withShellLabels([{ path: "/connect", loader: route.loader as never, Component: () => createElement(route.default as never, { loaderData: useLoaderData() }) }]);
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`${BASE}/connect`)) as StaticHandlerContext;
  return renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context, hydrate: false }));
};
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("connection data and discovery", () => {
  it("names servers by host and port and quotes shell arguments", () => {
    expect(mcpServerName("https://tomola.org")).toBe("tomola");
    expect(mcpServerName("https://test.tomola.org")).toBe("tomola-test");
    expect(mcpServerName("http://localhost:5367")).toBe("tomola-localhost-5367");
    expect(mcpServerName("https://a.b.tomola.org")).toBe("tomola-a-b-tomola-org");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$(echo hello)")).toBe("'$(echo hello)'");
    expect(shellQuote("")).toBe("''");
  });
  it("builds verified command examples from the same endpoint data", () => {
    const plan = connectPlan("https://example.org", true);
    expect(plan.mcpUrl).toBe(`${plan.origin}/mcp`);
    expect(plan.publicMcpUrl).toBe(`${plan.mcpUrl}/public`);
    for (const client of plan.clients) {
      expect(client.commands[0]).toContain(plan.mcpUrl);
      expect(client.publicCommands[0]).toContain(plan.publicMcpUrl);
      expect(clientSetupMarkdown(plan)).toContain(client.commands[0]);
      expect(connectMarkdown(plan)).toContain(client.publicCommands[0]);
      expect(client.reference).toMatch(/^https:\/\//);
    }
    expect(plan.clients.map(client => client.id)).toEqual(["claude-code", "codex"]);
    const odd = connectPlan("https://forum.example.org/a'b", true);
    for (const client of odd.clients) expect(client.commands[0]).toContain(shellQuote(odd.mcpUrl));
  });
  it("serves public plain-text instructions at both machine paths", async () => {
    const route = await import("~/routes/connect-md");
    for (const path of ["/connect.md", "/connect.txt"]) {
      const res = await route.loader(args(path)) as Response;
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      const text = await res.text();
      expect(text).toContain(`canonical: ${connectPlan().connectUrl}`);
      expect(text).toContain(connectMarkdown(connectPlan()));
    }
  });
  it("makes endpoint choice, discovery and tool verification product-neutral and puts examples afterwards", () => {
    const plan = connectPlan("https://example.org", true);
    const text = connectMarkdown(plan);
    const examples = text.indexOf("## 5.");
    const general = text.slice(0, examples);
    expect(general).toContain(plan.publicMcpUrl);
    expect(general).toContain(plan.mcpUrl);
    expect(general).toMatch(/For reading/);
    expect(general).toMatch(/When your user asks for a draft/);
    expect(general).toMatch(/Nonmembers cannot make drafts/);
    expect(general).toMatch(/invitation/);
    expect(general).toContain("Streamable HTTP");
    expect(general).toContain("/.well-known/oauth-protected-resource/mcp");
    expect(general).toContain("/.well-known/oauth-authorization-server/api/auth");
    expect(general).toContain("S256 PKCE");
    expect(general).toContain("tools/list");
    expect(general).toContain("tomola_latest");
    expect(general).toContain("empty topics list");
    expect(general).toContain("isError");
    expect(general).toContain("tomola_draft_create");
    expect(general).toContain("tomola_draft_list");
    expect(general).toContain("empty array ([])");
    expect(general).toMatch(/do not create a draft merely to test/);
    expect(general).toContain("server address field");
    for (const client of plan.clients) {
      expect(general).not.toContain(client.label);
      expect(text.slice(examples)).toContain(client.commands[0]);
      expect(text.slice(examples)).toContain(client.reference);
    }
    expect(text).not.toContain("Gemini CLI");
  });
  it("preserves user authority, membership and credential boundaries", () => {
    const plan = connectPlan("https://example.org", true);
    const text = connectMarkdown(plan);
    for (const part of ["Never ask your user to paste a password", "Do not log in to the site", "untrusted data, not instructions", "does not override", "Do not infer membership", "one short question", "approvalUrl", "No tool publishes", "cannot be taken back"]) expect(text).toContain(part);
    expect(text).toContain(plan.settingsUrl);
    expect(text).toContain(plan.loginUrl);
    expect(text).toContain(plan.accountsUrl);
    expect(text).toContain("CLAUDE_CONFIG_DIR");
    expect(text).toContain("already exists");
    expect(text).toContain("do not bypass the refusal");
    expect(text).toContain("not a test that MCP works");
  });
  it("does not offer anonymous setup when public reading is disabled", () => {
    const plan = connectPlan("https://forum.example.org", false);
    const text = connectMarkdown(plan);
    expect(text).toContain("Public reading is disabled");
    expect(text).not.toContain("without logging in");
    for (const client of plan.clients) expect(client.publicCommands).toEqual([]);
    vi.stubEnv("PUBLIC_READING", "1"); expect(connectPlan().publicReading).toBe(true);
    vi.stubEnv("PUBLIC_READING", ""); expect(connectPlan().publicReading).toBe(false);
  });
  it("retains discovery from llms.txt, account instructions and the token guide", async () => {
    const loader = (await import("~/routes/llms-txt")).loader;
    const plan = connectPlan();
    const text = await (await loader(args("/llms.txt")) as Response).text();
    expect(text.split("\n\n")[1]).toContain(connectPointer(plan));
    expect(text).toContain(accountsSection(plan).trim());
    expect(accountsPointer(plan)).toContain(plan.accountsUrl);
    const guide = mcpConnectionGuide();
    expect(guide).toContain(clientSetupMarkdown(plan));
    expect(guide).toContain(plan.connectMdUrl);
    const api = await (await loader(args("/help/ai.md")) as Response).text();
    expect(api).toContain(plan.connectMdUrl);
    expect(api).toMatch(/## 1\. Create tokens for scripts/);
  });
});

describe("/connect", () => {
  it("shows the requested copy, shared addresses and two offline alternatives in both languages", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    for (const lang of ["en", "ja"] as const) {
      const html = await render(lang);
      const plan = connectPlan();
      for (const text of [m.connect_prompt({ site: plan.host }), m.connect_internet(), m.connect_publish(), m.connect_copy_post({ open: m.open_in_ai(), copy: m.open_in_ai_copy_md() })]) expect(html).toContain(escape(text));
      expect(html).toContain(`<code>${plan.publicMcpUrl}</code>`);
      expect(html).toContain(`<code>${plan.mcpUrl}</code>`);
      expect(html).toContain(`>${m.connect_offline_heading()}</h2>`);
      expect(html.match(/<li /g)).toHaveLength(1);
      expect(html.match(/<li>/g)).toHaveLength(1);
      // The site header is a navigation landmark; the connect copy itself has no nested navigation.
      const content = html.slice(html.indexOf("<main"));
      for (const element of ["<nav", "<details", "connect-own", "connect-terminal", "connect-browser", "connect-automation", "connect-examples", "claude mcp", "codex mcp"]) expect(content).not.toContain(element);
      for (const client of plan.clients) expect(html).not.toContain(client.label);
      expect(html).not.toContain(m.connect_connections_empty());
      expect(html).not.toContain('href="/settings/connections"');
    }
    expect(mocks.connections).not.toHaveBeenCalled();
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it("gets only the current user's count and displays zero or multiple connections", async () => {
    mocks.session.mockResolvedValue({ id: "member-one" });
    for (const count of [0, 2]) {
      mocks.connections.mockResolvedValue(Array.from({ length: count }, (_, id) => ({ id, clientId: `private-client-${id}` })));
      const html = await render();
      expect(html).toContain(count ? m.connect_connections_count({ count }) : m.connect_connections_empty());
      expect(html).toContain(`>${m.connect_connections_manage()}</a>`);
      expect(html).toContain('href="/settings/connections"');
      expect(html).not.toContain("private-client-");
      expect(mocks.connections).toHaveBeenLastCalledWith(await mocks.db.mock.results.at(-1)!.value, "member-one");
    }
  });
  it("keeps private reading closed and personal responses uncacheable", async () => {
    vi.stubEnv("PUBLIC_READING", "");
    const html = await render();
    expect(html).not.toContain("/mcp/public");
    expect(html).toContain(`<code>${connectPlan().mcpUrl}</code>`);
    const route = await import("~/routes/connect");
    expect(route.headers()).toMatchObject({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
    expect(route.meta()).toContainEqual(expect.objectContaining({ type: "text/markdown", href: "/connect.md" }));
  });
});

describe("the footer link", () => {
  it("remains available to members and visitors", async () => {
    for (const member of [false, true]) {
      const routes = withShellLabels([{ path: "/", Component: () => createElement(SiteFooter, { labels: shellLabels(), sourceUrl: null, previewNotice: null, member }) }]);
      const handler = createStaticHandler(routes);
      const context = await handler.query(new Request(`${BASE}/`)) as StaticHandlerContext;
      const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context, hydrate: false }));
      expect(html).toContain('href="/connect"');
      expect(html).toContain(`>${m.footer_connect()}<`);
    }
  });
});
