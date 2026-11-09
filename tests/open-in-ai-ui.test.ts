import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTopic } from "~/lib/entries.server";
import { aiOpenLinks, revokeOpenInAiLinks, verifyOpenInAiToken } from "~/lib/open-in-ai.server";
import { buildOpenUrl, CHATGPT_TEMPLATE, CLAUDE_TEMPLATE, isValidTemplate, parseChoice, serializeChoice, type AiChoice } from "~/lib/open-in-ai";
import { getProfile } from "~/lib/profiles.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { getMd, parseBlocks } from "./helpers/md";

describe("templates and URL assembly", () => {
  it("knows the ChatGPT and Claude templates", () => {
    expect(CHATGPT_TEMPLATE).toBe("https://chatgpt.com/?q={prompt}");
    expect(CLAUDE_TEMPLATE).toBe("https://claude.ai/new?q={prompt}");
  });

  it("accepts an https URL that contains {prompt}, and nothing else", () => {
    for (const ok of ["https://example.com/?q={prompt}", "https://example.com/chat/{prompt}", "https://a.example/x?a=1&q={prompt}#f", "https://example.com:8443/?q={prompt}&again={prompt}"]) expect(isValidTemplate(ok), ok).toBe(true);
    for (const bad of ["", "https://example.com/", "http://example.com/?q={prompt}", "javascript:alert({prompt})", "ftp://example.com/{prompt}", "https://user:pw@example.com/?q={prompt}", "https://example.com/?q={PROMPT}", "{prompt}", "//example.com/?q={prompt}", "https://", `https://example.com/?q={prompt}${"x".repeat(2000)}`, "data:text/html,{prompt}"]) {
      expect(isValidTemplate(bad), bad).toBe(false);
    }
  });

  it("URL-encodes the prompt into every {prompt}", () => {
    const prompt = "次のページを読んで、一緒に考えてほしい：https://tomola.example/t/1.md?lang=en&k=oai1.u.1.0.AbC_-";
    const encoded = encodeURIComponent(prompt);
    expect(buildOpenUrl({ provider: "chatgpt" }, prompt)).toBe(`https://chatgpt.com/?q=${encoded}`);
    expect(buildOpenUrl({ provider: "claude" }, prompt)).toBe(`https://claude.ai/new?q=${encoded}`);
    expect(buildOpenUrl({ provider: "custom", template: "https://ai.example/go?q={prompt}&copy={prompt}" }, "a b&c")).toBe("https://ai.example/go?q=a%20b%26c&copy=a%20b%26c");
    // Encoded output contains no &, #, or spaces, so it cannot break the template query.
    expect(encoded).not.toMatch(/[&#\s]/);
    expect(new URL(buildOpenUrl({ provider: "claude" }, prompt)).searchParams.get("q")).toBe(prompt);
  });

  it("reads a saved choice back, and treats anything broken or unsafe as no choice", () => {
    const choices: AiChoice[] = [{ provider: "chatgpt" }, { provider: "claude" }, { provider: "custom", template: "https://ai.example/?q={prompt}" }];
    for (const c of choices) expect(parseChoice(serializeChoice(c))).toEqual(c);
    for (const raw of [null, "", "nope", "null", "[]", '{"provider":"gemini"}', '{"provider":"custom"}', '{"provider":"custom","template":"http://x/{prompt}"}', '{"provider":"custom","template":"javascript:{prompt}"}', '{"provider":"custom","template":5}']) {
      expect(parseChoice(raw), String(raw)).toBeNull();
    }
    // Discard extra fields.
    expect(parseChoice('{"provider":"claude","template":"https://evil.example/{prompt}"}')).toEqual({ provider: "claude" });
  });
});

describe("aiOpenLinks and the pages that show the button", () => {
  let h: RouteHarness;
  let topicId: number;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "題", body: "本文" });
    if (!t.ok) throw new Error("topic failed");
    topicId = t.id;
  });
  afterAll(() => h.restore());

  it("builds token-free absolute and relative Markdown URLs without issuing a credential", async () => {
    const profile = (await getProfile(h.db, h.ids.hana))!;
    const links = aiOpenLinks(h.request(`/t/${topicId}?page=2&lang=en&orig=3`), profile, `/t/${topicId}`);
    expect(links.mdPath).toBe(`/t/${topicId}.md?page=2&lang=en`);
    const url = new URL(links.mdUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`http://localhost:5173/t/${topicId}.md`);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("orig")).toBeNull();
    expect(links.mdPath).not.toContain("k=");
    expect(url.searchParams.get("k")).toBeNull();
    expect(aiOpenLinks(h.request("/latest?lang=xx&page=zz"), profile, "/latest").mdPath).toBe("/latest.md");
  });

  it("keeps credentials out of loader data, then issues one scoped link on a browser POST", async () => {
    // The home and a language list carry their order (?order=created: the screen's default) into the Markdown twin, so that the twin lists the same posts in the same order.
    const pages: Array<[string, string, Record<string, string>, string, string]> = [
      ["~/routes/topic", `/t/${topicId}`, { id: String(topicId) }, `/t/${topicId}.md`, ""],
      ["~/routes/home", "/", {}, "/home.md", "order=created"],
      ["~/routes/latest", "/latest", {}, "/latest.md", ""],
      ["~/routes/area", "/a/ja", { lang: "ja" }, "/a/ja.md", "order=created"],
    ];
    for (const [module, path, params, md, extra] of pages) {
      const { loader } = (await import(/* @vite-ignore */ module)) as { loader: (args: never) => Promise<{ aiOpen: { mdUrl: string; mdPath: string } }> };
      const data = await loader(h.args(h.request(path, { as: "hana" }), params));
      expect(data.aiOpen.mdPath, path).toBe(`${md}${extra ? `?${extra}` : ""}`);
      expect(new URL(data.aiOpen.mdUrl).searchParams.get("k"), path).toBeNull();
      expect(data.aiOpen.mdUrl, path).toBe(`http://localhost:5173${md}${extra ? `?${extra}` : ""}`);
      const { action } = await import("~/routes/open-in-ai-link");
      const issued = await action(h.args(h.request("/open-in-ai/link", { as: "hana", form: { path: data.aiOpen.mdPath } })));
      expect(issued.status).toBe(200);
      expect(issued.headers.get("cache-control")).toBe("private, no-store");
      const { url } = await issued.json();
      const k = new URL(url).searchParams.get("k")!;
      expect(await verifyOpenInAiToken(h.db, k, { resource: url })).toMatchObject({ ok: true, userId: h.ids.hana });
      expect(await verifyOpenInAiToken(h.db, k, { resource: "/manifest.json" })).toMatchObject({ ok: false, error: "scope_mismatch" });
    }
  });

  it("uses the same page numbers on the screen and in the Markdown twin while omitting unreferenced deleted replies", async () => {
    const { entries } = await import("~/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "削除の多い話題", body: "本文" });
    if (!t.ok) throw new Error("topic failed");
    const base = Date.parse("2026-10-01T00:00:00Z");
    const rows = await h.db
      .insert(entries)
      .values(Array.from({ length: 250 }, (_, i) => ({ kind: "reply", threadId: t.id, authorId: h.ids.hana, lang: "ja", body: `r${i}`, createdAt: new Date(base + i * 1000), updatedAt: new Date(base + i * 1000) })))
      .returning({ id: entries.id });
    // Delete the first 120 replies. Deleted replies retain their positions, so UI page 2 still contains global positions 101-200.
    for (const r of rows.slice(0, 120)) await h.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, r.id));
    await h.db.update(entries).set({ replyCount: 130 }).where(eq(entries.id, t.id));
    const { loader } = await import("~/routes/topic");
    type Page = { aiOpen: { mdPath: string }; replies: Array<{ id: number; placeholder: string | null }>; hasNextPage: boolean };
    const page2 = (await loader(h.args(h.request(`/t/${t.id}?page=2`, { as: "hana" }), { id: String(t.id) }))) as unknown as Page;
    expect(page2.replies).toHaveLength(80);
    expect(page2.replies.filter((r) => r.placeholder === "deleted")).toHaveLength(0);
    expect(page2.replies[0].id).toBe(rows[120].id);
    expect(page2.aiOpen.mdPath).toBe(`/t/${t.id}.md?page=2`);
    const page1 = (await loader(h.args(h.request(`/t/${t.id}`, { as: "hana" }), { id: String(t.id) }))) as unknown as Page;
    expect(page1.replies).toHaveLength(0);
    expect(page1.aiOpen.mdPath).toBe(`/t/${t.id}.md`);
    expect(page1.hasNextPage).toBe(true);
    const page3 = (await loader(h.args(h.request(`/t/${t.id}?page=3`, { as: "hana" }), { id: String(t.id) }))) as unknown as Page;
    expect(page3.replies).toHaveLength(50);
    expect(page3.aiOpen.mdPath).toBe(`/t/${t.id}.md?page=3`);
    expect(page3.hasNextPage).toBe(false);
    for (const [index, page] of [page1, page2, page3].entries()) {
      const blocks = parseBlocks(await (await getMd(h, page.aiOpen.mdPath, { as: "hana" })).text());
      expect(blocks.filter(block => block.fm.type === "comment").map(block => block.fm.id)).toEqual(page.replies.map(reply => `c-${reply.id}`));
      expect(blocks.at(-1)!.fm).toMatchObject({ page: index + 1, page_count: 3 });
    }
  });

  it("does not show a link to visitors, and signs new links with the new generation after the links were invalidated", async () => {
    const { loader } = await import("~/routes/latest");
    expect(await h.outcome(async () => (await loader(h.args(h.request("/latest")))))).toMatchObject({ status: 302, location: "/login?next=%2Flatest" });
    const { action } = await import("~/routes/open-in-ai-link");
    const issue = async () => (await action(h.args(h.request("/open-in-ai/link", { as: "hana", form: { path: "/latest.md" } })))).json();
    const before = await issue();
    const oldK = new URL(before.url).searchParams.get("k")!;
    await revokeOpenInAiLinks(h.db, h.ids.hana);
    expect(await verifyOpenInAiToken(h.db, oldK, { resource: "/latest.md" })).toEqual({ ok: false, error: "revoked" });
    const after = await issue();
    const newK = new URL(after.url).searchParams.get("k")!;
    expect(newK.split(".").at(-3)).toBe("1");
    expect((await verifyOpenInAiToken(h.db, newK, { resource: "/latest.md" })).ok).toBe(true);
  });

  it("requires a same-origin member POST and refuses private, ambiguous or pre-authorized resources", async () => {
    const { action, loader } = await import("~/routes/open-in-ai-link");
    const get = (await loader());
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(get.headers.get("cache-control")).toBe("private, no-store");
    const issue = (form: Record<string, string | string[]>, headers?: Record<string, string>, as: string | undefined = "hana") => h.outcome(() => action(h.args(h.request("/open-in-ai/link", { as, form, headers }))));
    expect(await issue({ path: "/latest.md" }, undefined, "missing")).toMatchObject({ status: 302, location: "/login" });
    // Header credentials cannot replace the browser session.
    expect(await issue({ path: "/latest.md" }, { authorization: "Bearer tml_read_invalid" }, "missing")).toMatchObject({ status: 302, location: "/login" });
    expect((await issue({ path: "/latest.md" }, { origin: "https://outside.example" })).status).toBe(403);
    for (const path of ["/settings/export", "/settings/stances", "/admin/export", "//outside.example/latest.md", "/\\outside.example/latest.md", "/latest.md?k=secret", "/latest.md?lang=ja&lang=en", "/latest.md#private", "https://outside.example/latest.md"]) {
      expect((await issue({ path })).status, path).toBe(400);
    }
    expect((await issue({ path: ["/latest.md", "/home.md"] })).status).toBe(400);
    const issued = await issue({ path: "/latest.txt?lang=en&page=1" });
    expect(issued.status).toBe(200);
    const url = new URL((await (issued.value as Response).json()).url);
    expect(url.pathname).toBe("/latest.md");
    expect(url.searchParams.get("page")).toBeNull();
    const token = url.searchParams.get("k")!;
    expect(await verifyOpenInAiToken(h.db, token, { resource: "/latest.md?lang=en" })).toMatchObject({ ok: true });
    expect(await verifyOpenInAiToken(h.db, token, { resource: "/latest.md?lang=ja" })).toEqual({ ok: false, error: "scope_mismatch" });
    expect(await verifyOpenInAiToken(h.db, token, { resource: "/latest.md?lang=en", now: new Date(Date.now() + 300_000) })).toEqual({ ok: false, error: "expired" });
  });
});
