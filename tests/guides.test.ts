import { operatorDocument } from "~/lib/operator-config.server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAFT_ISSUE_KINDS } from "~/lib/draft-issues";
import { DRAFT_RESPONSE_GUIDE } from "~/lib/api/draft-response-guide";
import { loader } from "~/routes/llms-txt";
import { MEMBER_EXPORT_VERSION } from "~/lib/exports.server";
import { AI_USE_GUIDANCE, AI_USE_GUIDANCE_TITLE } from "~/lib/api/ai-use-guidance.server";
import { connectMarkdown, connectPlan } from "~/lib/api/connect.server";
import { expectedPrinciplesStatus } from "./helpers/principles-source";

const BASE = "http://localhost:5173";
const get = async (path: string, method = "GET") => (await loader({ request: new Request(`${BASE}${path}`, { method }), params: {}, context: {} } as never)) as Awaited<Promise<Response>>;

describe("public guides", () => {
  it("documents bounded draft issues and language decisions from shared sources", async () => {
    const { mcpConnectionGuide } = await import("~/lib/mcp/guide.server");
    for (const text of [await (await get("/help/ai.md")).text(), await (await get("/llms.txt")).text(), mcpConnectionGuide()]) expect(text).toContain(DRAFT_RESPONSE_GUIDE);
    const doc = await (await get("/api/openapi.json")).json();
    expect(doc.components.schemas.DraftIssue.properties.kind.enum).toEqual([...DRAFT_ISSUE_KINDS]);
    const schema = doc.components.schemas.DraftCreated;
    expect(schema.required).toEqual(expect.arrayContaining(["issues", "issues_truncated", "lang", "language"]));
    expect(schema.properties).toHaveProperty("issues_unavailable");
    expect(schema.properties).toHaveProperty("issues_notice");
    for (const key of ["issuesTruncated", "issuesNotice", "issuesUnavailable"]) expect(schema.properties).not.toHaveProperty(key);
    const writing = (await (await get("/llms.txt")).text()).split("## Writing\n")[1]?.split("\n## ")[0];
    const response = writing?.match(/it returns `([^`]+)`/)?.[1];
    expect(response).toContain('"issues_truncated": false');
    expect(response).toContain('"language":');
  });
  it("shares the AI instructions between the connection and draft guides and points to them from the writing guide", async () => {
    const help = await (await get("/help/ai.md")).text();
    const connect = connectMarkdown(connectPlan(BASE));
    for (const text of [help, connect]) expect(text).toContain(AI_USE_GUIDANCE);
    const llms = await (await get("/llms.txt")).text();
    const writing = llms.split("## Writing\n")[1]?.split("\n## ")[0];
    const pointer = writing?.split("\n").find(line => line.includes(AI_USE_GUIDANCE_TITLE));
    expect(pointer).toContain(`${BASE}/help/ai.md`);
    expect(llms).not.toContain(AI_USE_GUIDANCE);
  });

  it("gives a short starting point for reading posts, selecting translations and finding recent topics", async () => {
    const text = await (await get("/llms.txt")).text();
    const section = text.split("## Start with a post and its discussion\n")[1]?.split("\n## ")[0];
    expect(section).toBeDefined();
    for (const term of ["/t/<id>.md", "?lang=<tag>", "?lang=all", "status", "machine", "human_edited", "stale: true", "translations_pending", "/latest.md"]) expect(section).toContain(term);
    expect(text.indexOf("## Start with a post")).toBeLessThan(text.indexOf("## Markdown twins"));
    const help = await (await get("/help/ai.md")).text();
    expect(help).toContain('$TOMOLA/t/1042.md?lang=all');
    const doc = JSON.parse(await (await get("/api/openapi.json")).text());
    const thread = doc.paths["/t/{id}.md"].get;
    expect(thread.parameters.find((p: { name: string }) => p.name === "lang").schema.anyOf).toContainEqual({ type: "string", const: "all" });
    expect(thread.responses["200"].description).toContain("translations_pending");
    expect(doc.paths["/latest.md"].get.parameters.find((p: { name: string }) => p.name === "lang").schema).toEqual({ $ref: "#/components/schemas/Lang" });
  });
  it("tell an AI what the overview counts, what unicode_review_reasons does and does not mean, and that reading marks nothing as read", async () => {
    const llms = await (await get("/llms.txt")).text();
    const help = await (await get("/help/ai.md")).text();
    for (const text of [llms, help]) {
      for (const term of ["replies_readable", "replies_on_page", "unicode_review_reasons", "bidi_control", "tag_characters"]) expect(text, term).toContain(term);
      expect(text).toMatch(/not (?:a finding|proof)/);
      expect(text).toMatch(/does not mark|never marks/);
    }
    expect(llms).toContain("not proof that you or anyone read or processed");
    expect(llms).toContain("not that the text is safe");
    // What reading changes and what it does not: the machine routes never, the ordinary pages as before, and the o= receipt is not a read mark.
    expect(llms).toContain("never marks a member's notifications as read and never moves their unread positions in replies");
    expect(llms).toContain("whether a person or an AI that drives a browser does it");
    expect(llms).toContain("the \`o=\` receipt");
    expect(llms).not.toContain("every other viewing state");
    // The overview counts the whole thread on every page, so it is stale as soon as any reply changes; and reply_langs is one number.
    expect(llms).toContain("changes the overview of every page of that thread");
    expect(llms).toContain("one number, never a count per language");
    const { mcpConnectionGuide } = await import("~/lib/mcp/guide.server");
    const mcp = mcpConnectionGuide();
    for (const term of ["never marks a member's notifications as read or moves their unread reply positions", "an AI driving a browser alike", "(o=) is a separate record", "unicode_review_reasons", "not proof of what any reader has processed", "its absence is not safety"]) expect(mcp, term).toContain(term);
    const doc = JSON.parse(await (await get("/api/openapi.json")).text());
    expect(doc.paths["/t/{id}.md"].get.responses["200"].description).toContain("unicode_review_reasons");
  });
  it("describe the integrated member export version and its own rows without offering it to read tokens", async () => {
    const text = await (await get("/llms.txt")).text();
    expect(text).toContain(`version: ${MEMBER_EXPORT_VERSION}`);
    expect(text).toContain("format: tomola-member-export");
    for (const key of ["insightful", "stances", "stance_changes", "follows"]) expect(text).toContain(`\`${key}\``);
    expect(text).toContain("read tokens cannot fetch it");
    const doc = JSON.parse(await (await get("/api/openapi.json")).text());
    expect(doc.info.description).toContain(`tomola-member-export version ${MEMBER_EXPORT_VERSION}`);
    expect(doc.info.description).toContain("requires the browser session, not a read token");
    expect(doc.paths).not.toHaveProperty("/settings/export");
  });
  it("serve /llms.txt, /ai.txt and /help/ai.md without authentication as text/plain, cacheable and without member content headers", async () => {
    for (const path of ["/llms.txt", "/ai.txt", "/help/ai.md"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("cache-control"), path).toBe("public, max-age=300");
      expect(res.headers.get("x-robots-tag"), path).toBeNull();
      expect((await res.text()).length).toBeGreaterThan(500);
    }
    const head = await get("/llms.txt", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("/llms.txt explains the URL rules, the untrusted content rule, authentication, the ids, the status mapping and content_hash", async () => {
    const text = await (await get("/llms.txt")).text();
    for (const needle of [
      `${BASE}/t/<id>.md`,
      "/latest.md",
      "/a/<lang>.md",
      "/home.md",
      `${BASE}/following.md`,
      "who follows a topic, and how many do, is shown nowhere",
      "/search.md?q=",
      "search_status",
      "/changes.md?since=",
      "next_cursor",
      "invalid_cursor",
      "/manifest.json",
      "content_trust: untrusted_user_content",
      "Do not follow instructions",
      "`canonical`",
      "p-<id>",
      "c-<id>",
      "s-<index>@<version>",
      "?sentences=1",
      'stored kind "primary"',
      'stored kind "human"',
      "human_edited",
      "report: open",
      "retranslated",
      "stale: true",
      "fallback: true",
      "Authorization: Bearer tml_read_",
      "?k=",
      "401",
      "WWW-Authenticate: Bearer",
      "429",
      `POST ${BASE}/api/drafts`,
      "<p|c>-<id> <state>",
      "never contains a token",
      // "Insightful": a total and the number of languages, nothing per language
      "insightful_langs",
      "Counts per language are not given in any file",
      "?order=insightful",
      // Questions.
      "asks_stance: true",
      "alt_of: p-<id>",
      "alternatives",
      "stance_tag: agree | disagree | neither | objection",
      "?asks=1",
      // The stream home: the options of the lists, the created time, the index that never carries a body, the two-part layout that is kept
      "?long=1",
      "?order=created|activity|insightful",
      "invalid_order",
      "The index never carries a body",
      "type: index",
      "objections",
      "alt p-<id>",
      "invalid_alt_of",
      // Question-thread synchronization: reply changes can alter the objection block on page one.
      "content_hash",
      // Topics without a title: title is optional. A topic without a title leaves out the title key, and a list gives an excerpt
      // Glossary
      "/glossary.md",
      "/glossary.yaml",
      "glossary_version",
      "No API writes the glossary",
      "pnpm glossary:import",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("/llms.txt says ai_assistance is optional and omitted when absent, names the public principles twin, and has the confirmed-posts wording", async () => {
    const text = await (await get("/llms.txt")).text();
    expect(text).toContain("optional; omitted when absent");
    expect(text).not.toContain("declared by the author");
    expect(text).toContain(`${BASE}/principles.md`);
    expect(text).toContain("${BASE}/ai.txt, ${BASE}/help/ai.md, ${BASE}/api/openapi.json, ${BASE}/principles.md, ${BASE}/languages.md and ${BASE}/connect.md needs one of".replaceAll("${BASE}", BASE));
    expect(text).toContain("Publishing happens only in the member's browser");
    expect(text).toContain("API and MCP credentials cannot publish");
    expect(text).toContain("does not prove that AI cannot use the passkey");
    expect(text).toContain("If the member has turned on passkey confirmation in settings");
    expect(text).not.toContain("AI cannot publish.");
    const help = await (await get("/help/ai.md")).text();
    expect(help).toContain("optional; omitted when absent");
    expect(help).toContain("Posts under your name are only those you have confirmed");
  });

  it("/ai.txt separates operator policy from public and member access", async () => {
    const text = await (await get("/ai.txt")).text();
    expect(text).toContain(operatorDocument("ai-policy", "en").trim());
    expect(text).not.toContain("council");
    expect(text).toContain("Public MCP reads need no credentials");
    expect(text).toContain("members-only");
  });

  it("/help/ai.md has curl examples for reading and for creating drafts, the token steps and the approval flow", async () => {
    const text = await (await get("/help/ai.md")).text();
    for (const needle of ["/settings/tokens", "curl -H \"Authorization: Bearer $READ_TOKEN\"", "/latest.md", "/t/1042.md?lang=en", "curl -X POST \"$TOMOLA/api/drafts\"", "Authorization: Bearer $DRAFT_TOKEN", "Content-Type: text/markdown", "approve_url", "Publish", "413", "415", "429", "machine", "human_edited", "asks_stance: true", "/latest.md?asks=1", "invalid_stance_tag", "/glossary.md?to=ja", "/glossary.yaml", "a short remark: a topic without a title", "a question always has a title", "required when `asks_stance` is true", "$TOMOLA/following.md"]) {
      expect(text, needle).toContain(needle);
    }
  });
});

describe("/api/openapi.json", () => {
  it.each(["", "1"])("matches public-reading authentication only on public Markdown paths (PUBLIC_READING=%s)", async setting => {
    vi.stubEnv("PUBLIC_READING", setting);
    try {
      const doc = await (await get("/api/openapi.json")).json();
      const authenticated = [{ readToken: [] }, { readTokenQuery: [] }, { sessionCookie: [] }];
      for (const path of ["/t/{id}.md", "/latest.md", "/home.md", "/a/{lang}.md"]) {
        expect(doc.paths[path].get.security, path).toEqual(setting === "1" ? [...authenticated, {}] : authenticated);
        expect(doc.paths[path].get.responses).toHaveProperty("401");
      }
      for (const path of ["/following.md", "/search.md", "/t/{id}/stances.md", "/glossary.md", "/changes.md", "/manifest.json"]) {
        expect(doc.paths[path].get.security, path).toEqual(authenticated);
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it("is a public OpenAPI 3.1 document describing the read endpoints, the feed, the manifest and POST /api/drafts with the security schemes", async () => {
    const res = await get("/api/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const doc = JSON.parse(await res.text());
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: BASE }]);
    // Questions: list ?asks=1, new draft errors and frontmatter.
    for (const path of ["/latest.md", "/home.md", "/following.md", "/a/{lang}.md"]) expect(doc.paths[path].get.parameters.map((p: { name: string }) => p.name), path).toContain("asks");
    // The stream home: the lists have ?long=1 and ?order=created|activity|insightful, and /home.md is one index of every language.
    for (const path of ["/latest.md", "/home.md", "/a/{lang}.md"]) {
      const names = doc.paths[path].get.parameters.map((p: { name: string }) => p.name);
      expect(names, path).toEqual(expect.arrayContaining(["long", "order"]));
      expect(doc.paths[path].get.parameters.find((p: { name: string }) => p.name === "order").schema.enum, path).toEqual(["created", "activity", "insightful"]);
    }
    expect(doc.paths["/home.md"].get.summary).toContain("every language");
    expect(JSON.stringify(doc.paths["/home.md"])).not.toMatch(/local topics|other areas/i);
    expect(doc.paths["/api/drafts"].post.description).toContain("asks_stance");
    expect(doc.paths["/api/drafts"].post.description).toContain("cannot be written through the API");
    // The title is optional (a topic without a title is a short remark); a question needs it.
    expect(doc.paths["/api/drafts"].post.description).toContain("title (optional: a topic without a title is a short remark; required when asks_stance is true)");
    expect(doc.paths["/api/drafts"].post.responses["400"].description).toContain("invalid_alt_of");
    expect(Object.keys(doc.paths).sort()).toEqual(["/a/{lang}.md", "/ai.txt", "/api/drafts", "/changes.md", "/following.md", "/glossary.md", "/glossary.yaml", "/help/ai.md", "/home.md", "/latest.md", "/llms.txt", "/manifest.json", "/principles.md", "/search.md", "/t/{id}.md", "/t/{id}/stances.md"]);
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(["draftToken", "readToken", "readTokenQuery", "sessionCookie"]);
    expect(doc.components.securitySchemes.readTokenQuery).toMatchObject({ type: "apiKey", in: "query", name: "k" });
    expect(doc.components.securitySchemes.draftToken).toMatchObject({ type: "http", scheme: "bearer" });
    // Drafts require draft tokens; reads accept any of three authentication methods.
    expect(doc.paths["/api/drafts"].post.security).toEqual([{ draftToken: [] }]);
    expect(Object.keys(doc.paths["/api/drafts"].post.responses).sort()).toEqual(["201", "400", "401", "403", "405", "413", "415", "429", "503"]);
    expect(Object.keys(doc.paths["/api/drafts"].post.requestBody.content).sort()).toEqual(["text/markdown", "text/plain"]);
    expect(doc.paths["/t/{id}.md"].get.security).toEqual([{ readToken: [] }, { readTokenQuery: [] }, { sessionCookie: [] }]);
    expect(doc.paths["/llms.txt"].get.security).toEqual([]);
    // The principles page's twin is public, like the guides; ai_assistance is optional in the draft API.
    expect(doc.paths["/principles.md"].get.security).toEqual([]);
    expect(doc.paths["/principles.md"].get.parameters.map((p: { name: string }) => p.name)).toEqual(["lang"]);
    const { PRINCIPLES_LANGS } = await import("~/lib/principles-languages");
    const { llmsTxt } = await import("~/lib/api/guides.server");
    expect(doc.paths["/principles.md"].get.parameters[0].schema).toEqual({ $ref: "#/components/schemas/PrinciplesLang" });
    expect(doc.components.schemas.PrinciplesLang.enum).toEqual([...PRINCIPLES_LANGS]);
    expect(doc.components.schemas.Lang.enum).toHaveLength(9);
    for (const lang of PRINCIPLES_LANGS) {
      expect(doc.paths["/principles.md"].get.description).toContain(`${lang}: ${expectedPrinciplesStatus(lang)}`);
      expect(llmsTxt()).toContain(`${lang}: ${expectedPrinciplesStatus(lang)}`);
    }
    expect(doc.paths["/api/drafts"].post.description).toContain("ai_assistance (optional");
    expect(doc.paths["/changes.md"].get.parameters.map((p: { name: string }) => p.name)).toEqual(["since", "cursor", "k"]);
    expect(new RegExp(doc.paths["/changes.md"].get.parameters[1].schema.pattern).test("2026-10-01T00:20:00.000Z_12")).toBe(true);
    // Search requires q and read authentication; budget pauses return literal-only results.
    expect(doc.paths["/search.md"].get.security).toEqual([{ readToken: [] }, { readTokenQuery: [] }, { sessionCookie: [] }]);
    expect(doc.paths["/search.md"].get.parameters.find((p: { name: string }) => p.name === "q")).toMatchObject({ required: true, schema: { maxLength: 500 } });
    expect(Object.keys(doc.paths["/search.md"].get.responses)).toEqual(expect.arrayContaining(["200", "400", "429"]));
    // Glossary: read authentication, the arguments of the page, 400 for a bad language; the download has no arguments
    expect(doc.paths["/glossary.md"].get.security).toEqual([{ readToken: [] }, { readTokenQuery: [] }, { sessionCookie: [] }]);
    expect(doc.paths["/glossary.md"].get.parameters.map((p: { name: string }) => p.name)).toEqual(["to", "from", "deleted", "page", "k"]);
    expect(Object.keys(doc.paths["/glossary.md"].get.responses)).toEqual(expect.arrayContaining(["200", "400", "401", "403", "429"]));
    expect(doc.paths["/glossary.yaml"].get.parameters.map((p: { name: string }) => p.name)).toEqual(["k"]);
    expect(doc.paths["/glossary.yaml"].get.responses["200"].content).toHaveProperty("text/yaml");
    expect(JSON.stringify(doc.paths).match(/glossary/g)?.length).toBeGreaterThan(0);
    expect(Object.keys(doc.paths).some((p) => /^\/api\/glossary/.test(p))).toBe(false);
    // Every $ref resolves.
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const name of refs) expect(doc.components.schemas, name).toHaveProperty(name);
    expect(doc.components.schemas.Lang.enum).toEqual(["ja", "en", "fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"]);
  });
});

describe("the totals and the number of languages in the guides and the OpenAPI document", () => {
  it("describe insightful_langs and total_langs as a number of languages, and never describe a count per language area or say that there is no total", async () => {
    const docText = JSON.stringify(JSON.parse(await (await get("/api/openapi.json")).text()));
    const texts: Array<[string, string]> = [
      ["/llms.txt", await (await get("/llms.txt")).text()],
      ["/help/ai.md", await (await get("/help/ai.md")).text()],
      ["/api/openapi.json", docText],
    ];
    for (const [name, text] of texts) {
      for (const word of ["votes_by_area", "insightful_by_area", "there is no total", "no total"]) expect(text, `${name}: ${word}`).not.toContain(word);
    }
    // the number of languages is described where the totals are
    expect(texts[0][1]).toContain("insightful_langs: from how many languages they come");
    expect(texts[1][1]).toContain("insightful_langs");
    expect(docText).toContain("total_langs (from how many languages those members come)");
    expect(docText).toContain("insightful_langs (from how many languages they come)");
    expect(docText).toContain("No counts per language");
    expect(texts[0][1]).toContain("total_langs");
  });
});

describe("the guides name the languages of the site (ENABLED_LANGS)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("explain mentions: the syntax, who is notified and how many, quotes, that it is not a link, the Markdown twins, and the draft", async () => {
    const llms = await (await get("/llms.txt")).text();
    const section = llms.slice(llms.indexOf("## Mentions"), llms.indexOf("## Search"));
    for (const needle of ["`@handle`", "`＠`", "display name", "unique without regard to case or width", "`@hanaさん`", "longest existing handle", "kind `mention`", "at most 10 members per post", "block quote", "suspended", "not a link", "no member pages", "Markdown twins give the body as it was written", "keeps `@handle` as written", "notifies nobody until a member publishes it"]) {
      expect(section, needle).toContain(needle);
    }
    const help = await (await get("/help/ai.md")).text();
    expect(help).toContain("Mentions: write `@handle` in the body");
    expect(help).toContain("/llms.txt");
    for (const text of [section, help]) {
      for (const needle of ["unique username", "display_name_latin", "nonunique", "not proof of identity"]) expect(text).toContain(needle);
      expect(text).not.toMatch(/handle is the display name|display names are unique|longest display name/);
    }
  });

  it("say that posts are translated into the enabled languages, which ?lang= and the draft lang accept, not into nine", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const llms = await (await get("/llms.txt")).text();
    expect(llms).toContain("available machine translations can be read in the languages of this site (ja, en)");
    expect(llms).not.toContain("into nine languages");
    // each sentence about ?lang= appears once (a doubled sentence slipped in once)
    expect(llms.split("must be one of the languages of this site (ja, en); another tag is 400 `invalid_lang`").length - 1).toBe(1);
    expect(llms).toContain("must be one of the languages of this site (ja, en); another tag is 400 `invalid_lang`");
    expect(await (await get("/help/ai.md")).text()).toContain("`lang` (one of the languages of this site: ja, en;");
    // the original of a post is readable whatever its language: /a/<lang>.md still names the nine tags of the software
    expect(llms).toMatch(/\/a\/<lang>\.md \(<lang> is one of the nine tags the software supports: ja, en, fr, de, zh-Hant, zh-Hans, ko, th, vi/);
    // the glossary arguments follow the same list, while the YAML download keeps all nine languages
    expect(llms).toContain("each one of the languages of this site (ja, en; another tag is 400 `invalid_lang`");
    vi.stubEnv("ENABLED_LANGS", "ja,en,fr,zh-Hans,zh-Hant");
    expect(await (await get("/llms.txt")).text()).toContain("languages of this site (ja, en, fr, zh-Hant, zh-Hans)");
  });
});
