import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, useLoaderData, type StaticHandlerContext } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { writingMarkdown } from "~/lib/api/writing.server";
import { connectMarkdown, connectPlan } from "~/lib/api/connect.server";
import { helpAiMd, llmsTxt } from "~/lib/api/guides.server";
import { DRAFT_RESPONSE_GUIDE } from "~/lib/api/draft-response-guide";
import { mediaUploadGuide } from "~/lib/api/media-guide.server";
import { mcpConnectionGuide } from "~/lib/mcp/guide.server";
import { markdownDetailsExample, markdownSpecimen, markdownWritingExamples } from "~/lib/markdown-specimen";
import { inspectDraftRendering } from "~/lib/markdown.core.server";
import { MAX_BODY_BYTES, MAX_REPLY_BODY_LENGTH, MAX_TOPIC_BODY_LENGTH } from "~/lib/body-length";
import { MEDIA_LIMITS, MOTION_LIMITS } from "~/lib/media";
import { m } from "~/paraglide/messages.js";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { withShellLabels } from "./helpers/render-in-router";
import { routeElement } from "./helpers/route-fixtures";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => { vi.unstubAllEnvs(); setTestLocale("en"); });
const BASE = "https://forum.example.org";
const args = (path: string, method = "GET") => ({ request: new Request(`${BASE}${path}`, { method }), params: {}, context: {} }) as never;
const formatted = (value: number) => value.toLocaleString("en-US");

describe("public writing instructions", () => {
  for (const reading of [false, true]) it(`serves both machine paths without authentication, public reading=${reading}`, async () => {
    vi.stubEnv("PUBLIC_READING", reading ? "1" : "");
    vi.stubEnv("BETTER_AUTH_URL", BASE);
    const { loader } = await import("~/routes/writing-md");
    for (const path of ["/writing.md", "/writing.txt"]) {
      const res = loader(args(path));
      expect(res.status).toBe(200);
      expect(Object.fromEntries(res.headers)).toMatchObject({ "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300", "x-robots-tag": "noindex", "x-content-type-options": "nosniff" });
      const text = await res.text();
      expect(text).toContain(`type: page\nid: writing\nlang: en\ncanonical: ${BASE}/writing`);
      expect(text).toContain(writingMarkdown(BASE));
      expect(text).not.toMatch(/test\.tomola|localhost|\/home\/|handoff|decision \d/i);
      const head = loader(args(path, "HEAD"));
      expect(await head.text()).toBe("");
      expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(res.headers));
    }
    const refused = loader(args("/writing.md", "POST"));
    expect(refused.status).toBe(405);
    expect(refused.headers.get("allow")).toBe("GET, HEAD");
  });

  it("renders every displayed example without diagnostics and shares calibration examples", () => {
    const examples = markdownWritingExamples();
    const text = writingMarkdown(BASE);
    for (const example of examples) {
      expect(text).toContain(example.markdown.trim());
      expect(inspectDraftRendering(example.markdown, "en").issues, example.label).toEqual([]);
    }
    expect(inspectDraftRendering(examples.map(example => example.markdown).join("\n\n"), "en").issues).toEqual([]);
    for (const lang of ["en", "ja"] as const) {
      expect(markdownSpecimen(lang)).toHaveLength(50_000);
      expect(markdownSpecimen(lang)).toContain(markdownDetailsExample(lang));
    }
    expect(examples.find(example => example.label === "Still and motion pair")?.markdown).toMatch(/\[!\[.+\]\(\/media\/[a-f0-9]{64}-800x450\.webp\)\]\(\/media\/[a-f0-9]{64}-800x450\.webp\)/);
  });

  it("uses current limits and shares the upload instructions and draft diagnostics once", () => {
    const text = writingMarkdown(BASE);
    for (const value of [MAX_TOPIC_BODY_LENGTH, MAX_REPLY_BODY_LENGTH, MAX_BODY_BYTES, MEDIA_LIMITS.perPost, MEDIA_LIMITS.inputBytes, MEDIA_LIMITS.pixels, MEDIA_LIMITS.edge, MEDIA_LIMITS.storedBytes, MOTION_LIMITS.width, MOTION_LIMITS.height, MOTION_LIMITS.frames, MOTION_LIMITS.durationMs / 1000, MOTION_LIMITS.pixels, MOTION_LIMITS.storedBytes]) expect(text).toContain(formatted(value));
    expect(text).toContain(DRAFT_RESPONSE_GUIDE);
    expect(text.split(mediaUploadGuide(BASE))).toHaveLength(2);
    expect(text).not.toMatch(/There is currently no image-upload tool|Images can be uploaded only on topic writing screens/);
    for (const item of ["tomola_draft_create", "tomola_draft_update", `POST ${BASE}/api/drafts`, "approvalUrl", "approve_url", "animated PNG", "MathJax", "alt text", "one original language", "permission to publish", "Avoid flashing", "once when it comes into view", "reduced motion"]) expect(text).toContain(item);
  });

  it("explains file uploads with separate permission and returned still or motion URLs", () => {
    const text = writingMarkdown(BASE);
    for (const instruction of [`POST ${BASE}/api/media`, "“Upload images” explicitly selected", "separately granted media scope", "Existing read/draft credentials do not gain this permission", "URLs are site-relative", "![description](url)", "[![description](posterUrl)](url)", "Use those URLs in the body of a draft", "review and publish in the browser", "A draft-only image remains readable only by its owner", "MCP does not import image URLs"]) expect(text).toContain(instruction);
    expect(text).toContain("URLs returned by the image upload API or the writing screen after upload");
    const fallback = text.split("### When your AI cannot upload images\n")[1];
    for (const instruction of ["If you cannot send image files", "chat-only AI", "image files and their alt text", "open its approval URL in the browser and upload the files there", "Do not invent an upload endpoint", "external image URLs"]) expect(fallback).toContain(instruction);
  });

  it("limits image uploads to topics and describes overflow as a display limit", () => {
    const text = writingMarkdown(BASE);
    const handoff = text.split("### Images for topics\n")[1];
    const restriction = "Replies have no image-upload control";
    expect(handoff).toContain("Images are supported only in topics, not replies");
    expect(handoff).toContain("a new topic, a topic draft or a topic edit");
    expect(handoff).toContain(restriction);
    expect(text.split(restriction)).toHaveLength(2);
    expect(handoff).toContain("a topic draft's writing screen");
    expect(text).toContain("editing a topic");
    expect(text).toContain(`Displayed images per topic: at most ${formatted(MEDIA_LIMITS.perPost)}`);
    expect(text).toContain("Excess images do not reject the draft or post; they become alt text");
    expect(text).toContain("two slots toward this display limit");
    expect(text).not.toMatch(/Images per post or reply|editing a post|or a draft's writing screen/);
  });

  it("reads the current draft before revising and preserves browser changes in both instructions", () => {
    const text = writingMarkdown(BASE);
    const delivery = text.split("### With an AI connection or script\n")[1].split("### Read the draft diagnostics")[0];
    const handoff = text.split("### Images for topics\n")[1];
    for (const section of [delivery, handoff]) {
      expect(section.indexOf("tomola_draft_get")).toBeLessThan(section.indexOf("tomola_draft_update"));
      for (const instruction of ["current body", "image Markdown", "expectedVersion"]) expect(section).toContain(instruction);
    }
    expect(delivery).toContain("This API creates drafts only");
    expect(delivery).toContain("have the author reopen it in the browser, read its current body");
    expect(handoff).toContain("read the draft again before proposing a revision");
    expect(handoff).toContain("have the author reopen the current draft in the browser");
  });

  it("describes the no-script motion link below the still", () => {
    expect(writingMarkdown(BASE)).toContain("With no JavaScript, a link below the still opens the motion version.");
  });

  it("discovers both guides from connection, writing and machine entry points", () => {
    vi.stubEnv("BETTER_AUTH_URL", BASE);
    for (const text of [connectMarkdown(connectPlan(BASE)), llmsTxt(), helpAiMd(), mcpConnectionGuide()]) expect(text).toContain(`${BASE}/writing.md`);
    for (const file of ["app/routes/connect.tsx", "app/components/entry-fields.tsx", "app/components/reply-extras-content.tsx"]) {
      const text = readFileSync(file, "utf8");
      expect(text).toContain("WRITING_PATH");
      expect(text).toContain("m.writing_guide_title()");
    }
    const routes = readFileSync("app/routes.ts", "utf8");
    for (const path of ["writing", "writing.md", "writing.txt"]) expect(routes).toContain(`route("${path}",`);
    expect(routes.indexOf('route("writing",')).toBeLessThan(routes.indexOf('layout("routes/member-layout.tsx"'));
  });

  it("follows changed numeric constants rather than copied prose values", async () => {
    const body = { MAX_TOPIC_BODY_LENGTH: 123_457, MAX_REPLY_BODY_LENGTH: 54_321, MAX_BODY_BYTES: 345_678 };
    const media = { ...MEDIA_LIMITS, perPost: 19, inputBytes: 456_789, pixels: 789_012, edge: 1234, storedBytes: 234_567 };
    const motion = { ...MOTION_LIMITS, width: 3456, height: 2345, frames: 345, durationMs: 45_000, pixels: 890_123, storedBytes: 567_890 };
    vi.doMock("~/lib/body-length", () => body);
    vi.doMock("~/lib/media", async importOriginal => ({ ...await importOriginal<typeof import("~/lib/media")>(), MEDIA_LIMITS: media, MOTION_LIMITS: motion }));
    vi.resetModules();
    try {
      const text = (await import("~/lib/api/writing.server")).writingMarkdown(BASE);
      const limits = text.split("## Limits\n")[1].split("## Examples")[0];
      for (const value of [...Object.values(body), media.perPost, media.inputBytes, media.pixels, media.edge, media.storedBytes, motion.width, motion.height, motion.frames, motion.durationMs / 1000, motion.pixels, motion.storedBytes]) expect(limits).toContain(formatted(value));
      const figures = text.split("### Prepare figures for reading\n")[1]?.split("\n### ")[0];
      expect(figures).toContain(formatted(media.edge));
    } finally {
      vi.doUnmock("~/lib/body-length");
      vi.doUnmock("~/lib/media");
      vi.resetModules();
    }
  });
});

describe("the short page for people", () => {
  for (const lang of ["en", "ja", "fr", "ko", "zh-Hans", "zh-Hant"] as const) it(`shows the address and four translated points in ${lang}`, async () => {
    vi.stubEnv("BETTER_AUTH_URL", BASE);
    setTestLocale(lang);
    const route = await import("~/routes/writing");
    const routes = withShellLabels([{ path: "/writing", loader: route.loader, Component: () => routeElement(route.default, { loaderData: useLoaderData<typeof route.loader>() }) }]);
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request(`${BASE}/writing`)) as StaticHandlerContext;
    const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context, hydrate: false }));
    const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    for (const text of [m.writing_guide_title(), m.writing_guide_prompt(), m.writing_guide_formats(), m.writing_guide_language(), m.writing_guide_rights(), m.writing_guide_publish()]) expect(html).toContain(escape(text));
    expect(html).toContain(`${BASE}/writing.md`);
    expect(html).toContain('href="/writing.md"');
    expect(html).toMatch(/<fieldset\b[^>]*\sdisabled=""/);
    expect(html.match(/<li>/g)).toHaveLength(4);
    expect(route.meta()).toContainEqual(expect.objectContaining({ type: "text/markdown", href: "/writing.md" }));
    expect(route.headers()).toMatchObject({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
  });
});
