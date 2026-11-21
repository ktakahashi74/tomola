import { withShellLabels } from "./helpers/render-in-router";
import { shellLabels } from "~/lib/shell-labels.server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, useLoaderData, type StaticHandlerContext } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteFooter } from "~/components/site-footer";
import { accountsPointer, accountsSection, appGuidesMarkdown, clientSetupMarkdown, connectAccountSection, connectManualSection, connectMarkdown, connectPlan, connectPointer, connectSafetySection, connectVerificationSection, mcpServerName, shellQuote } from "~/lib/api/connect.server";
import { mcpConnectionGuide } from "~/lib/mcp/guide.server";
import { mediaUploadGuide } from "~/lib/api/media-guide.server";
import { REPLY_MORE_SYMBOL } from "~/lib/reply-more";
import { m } from "~/paraglide/messages.js";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { routeElement } from "./helpers/route-fixtures";

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
  const routes = withShellLabels([{ path: "/connect", loader: route.loader as never, Component: () => routeElement(route.default, { loaderData: useLoaderData<typeof route.loader>() }) }]);
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
    const examples = text.indexOf("## Official guides and command examples");
    const general = text.slice(0, examples);
    expect(general).toContain(plan.publicMcpUrl);
    expect(general).toContain(plan.mcpUrl);
    expect(general).toMatch(/For reading/);
    expect(general).toContain("explicitly asks to connect this site to their account");
    expect(general).toContain("member tools: drafts");
    expect(general).toContain("tomola_activity with notifications");
    expect(general).toMatch(/Nonmembers cannot make drafts/);
    expect(general).toMatch(/invitation/);
    expect(general).toContain("Streamable HTTP");
    expect(general).toContain("/.well-known/oauth-protected-resource/mcp");
    expect(general).toContain("/.well-known/oauth-authorization-server/api/auth");
    expect(general).toContain("S256 PKCE");
    expect(general).toContain("tools/list");
    expect(general).toContain("tomola_capabilities");
    expect(general).toContain("tomola_latest");
    expect(general).toContain("empty list");
    expect(general).toContain("isError");
    expect(general).toContain("tomola_draft_create");
    expect(general).toContain("tomola_draft_list");
    expect(general).toContain("empty array ([])");
    expect(general).toContain("without creating a test draft");
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
  it.each([false, true])("shares connection sections in both machine guides with public reading=%s", async publicReading => {
    vi.stubEnv("PUBLIC_READING", publicReading ? "1" : "");
    const plan = connectPlan();
    const connect = (await import("~/routes/connect-md")).loader;
    const guide = (await import("~/routes/mcp-guide")).loader;
    const pages = [await (await connect(args("/connect.md")) as Response).text(), await (await guide(args("/help/mcp.md")) as Response).text()];
    for (const text of pages) {
      for (const section of [connectAccountSection, connectVerificationSection, connectManualSection, connectSafetySection, appGuidesMarkdown, clientSetupMarkdown]) expect(text).toContain(section(plan));
      expect(text).toContain("A client registered without media will receive invalid_scope if it requests media; reconnect and register the client again with media included.");
      const removal = text.indexOf("a read-only connection to the same site is no longer needed");
      expect(removal >= 0).toBe(publicReading);
      if (publicReading) expect(text.indexOf("tomola_draft_list")).toBeLessThan(removal);
    }
    expect(connectSafetySection(plan).includes(plan.publicMcpUrl)).toBe(publicReading);
  });
  it("requires draft verification only for a member connection requesting drafts", () => {
    const text = connectVerificationSection(connectPlan());
    expect(text).toContain("For a member connection requesting draft, also check that `tomola_draft_create` is listed, then call `tomola_draft_list`");
    expect(text).not.toContain("For every member connection");
  });
  it.each([false, true])("shares image upload instructions across writing and connection pages with public reading=%s", async publicReading => {
    vi.stubEnv("PUBLIC_READING", publicReading ? "1" : "");
    vi.stubEnv("BETTER_AUTH_URL", "https://forum.example.org");
    const plan = connectPlan();
    const connect = (await import("~/routes/connect-md")).loader;
    const llms = (await import("~/routes/llms-txt")).loader;
    const writing = (await import("~/routes/writing-md")).loader;
    for (const [path, loader] of [["/connect.md", connect], ["/llms.txt", llms], ["/writing.md", writing], ["/writing.txt", writing]] as const) {
      const text = await (await loader(args(path)) as Response).text();
      expect(text.split(mediaUploadGuide(plan.origin)), path).toHaveLength(2);
      expect(text, path).not.toMatch(/There is currently no image-upload tool|Images can be uploaded only on topic writing screens/);
    }
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
    expect(text.split("\n\n").find(paragraph => paragraph.startsWith("> tomola "))).toContain(connectPointer(plan));
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
  for (const lang of ["en", "ja"] as const) for (const member of [false, true]) for (const publicReading of [false, true]) {
    it(`shows purpose-based addresses and manual writing for ${lang}, member=${member}, public=${publicReading}`, async () => {
      vi.stubEnv("PUBLIC_READING", publicReading ? "1" : "");
      mocks.session.mockResolvedValue(member ? { id: "member-one" } : null);
      const html = await render(lang);
      const plan = connectPlan();
      const route = await import("~/routes/connect");
      const data = await route.loader(args("/connect"));
      expect(data.addresses.map(address => address.url)).toEqual(publicReading
        ? member ? [plan.mcpUrl, plan.publicMcpUrl] : [plan.publicMcpUrl, plan.mcpUrl]
        : [plan.mcpUrl]);
      expect(data.text.prompt).toBe(member ? m.connect_member_prompt({ site: plan.host }) : m.connect_prompt({ site: plan.host }));
      expect(data.addresses[0].label).toBe(!member && !publicReading ? m.connect_members_address() : m.connect_public_address());
      if (publicReading) expect(data.addresses[1].label).toBe(member ? m.connect_read_only_address() : m.connect_member_address());
      for (const text of [data.text.prompt, m.connect_internet(), m.connect_publish({ title: m.mcp_connect_title(), allow: m.mcp_allow() }), m.connect_copy_post({ open: m.open_in_ai(), copy: m.open_in_ai_copy_md() }), m.connect_write_without_connection({ write: m.ai_write_button(), more: REPLY_MORE_SYMBOL })]) expect(html).toContain(escape(text));
      for (const { url } of data.addresses) expect(html).toContain(`<code>${url}</code>`);
      expect(html.indexOf("<code>")).toBeLessThan(html.indexOf('id="connect-offline-heading"'));
      expect(html.slice(html.indexOf('id="connect-offline-heading"'))).not.toContain("<code>");
      expect(html.includes(escape(m.connect_connections_read_only()))).toBe(member);
      expect(html.includes(escape(m.connect_read_only_address()))).toBe(member && publicReading);
      if (!publicReading) expect(html).not.toContain(plan.publicMcpUrl);
      // Server-rendered buttons cannot imply that copying works before hydration.
      expect(html.match(/<fieldset\b[^>]*\sdisabled=""/g)).toHaveLength(data.addresses.length);
      const content = html.slice(html.indexOf("<main"));
      for (const element of ["<nav", "<details", "claude mcp", "codex mcp"]) expect(content).not.toContain(element);
      for (const client of [...plan.clients, ...plan.appGuides]) expect(html).not.toContain(client.label);
      if (!member) {
        expect(mocks.connections).not.toHaveBeenCalled();
        expect(mocks.db).not.toHaveBeenCalled();
        expect(html).not.toContain('href="/settings/connections"');
      }
    });
  }
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
