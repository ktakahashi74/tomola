import { describe, expect, it } from "vitest";
import { aiWriteDestination, aiWritePrompt, appendAiText, defaultAiWriteTask, AI_WRITE_TASKS, AI_WRITE_URL_LIMIT } from "~/lib/ai-draft";
import { createDraft, getDraft, publishDraft, updateDraft } from "~/lib/drafts.server";
import { drafts, entries, jobs } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";

describe("instructions and external destinations", () => {
  it("keeps a short Japanese article and comment under the encoded URL limit for both built-in choices", () => {
    const body = "https://example.org/article\n\nこの記事について考えたい。";
    expect(defaultAiWriteTask(body)).toBe("introduce");
    expect(defaultAiWriteTask("書きかけの文章")).toBe("revise");
    for (const task of AI_WRITE_TASKS) {
      const prompt = aiWritePrompt({ task, lang: "ja", body, returnUrl: "https://tomola.example/drafts/123" });
      for (const provider of ["chatgpt", "claude"] as const) {
        const { url } = aiWriteDestination({ provider }, prompt);
        expect(url).not.toBeNull();
        expect(url!.length).toBeLessThanOrEqual(AI_WRITE_URL_LIMIT);
        expect(new URL(url!).searchParams.get("q")).toBe(prompt);
      }
    }
    const prompt = aiWritePrompt({ task: "introduce", lang: "ja", body, returnUrl: "https://tomola.example/drafts/123" });
    expect(prompt).toContain(body);
    expect(prompt).toContain("Language: ja");
    expect(prompt).toContain("Do not fetch or write this private draft");
    expect(prompt).toContain("If you cannot read it, say so");
  });

  it("has a fifth task that asks for notes and never for text: no shared closing, no import, the member's words in full", () => {
    expect(AI_WRITE_TASKS).toEqual(["introduce", "summarize", "translate", "revise", "question"]);
    const body = "https://example.org/a\n\nWe will take the shuttle at once.";
    // The default task never becomes the question, with or without a link.
    expect(defaultAiWriteTask(body)).toBe("introduce");
    expect(defaultAiWriteTask("a draft")).toBe("revise");
    const prompt = aiWritePrompt({ task: "question", lang: "en", body, returnUrl: "https://tomola.example/drafts/9" });
    expect(prompt).toContain(body);
    expect(prompt).toContain("Language: en");
    expect(prompt).toContain("Do not write a replacement for my text and do not rewrite it");
    expect(prompt).toContain("At most 5 items");
    expect(prompt).toContain("End with one question for me");
    expect(prompt).toContain("hypotheses");
    // None of the shared closing of the writing tasks: it would ask for a finished body to bring back.
    for (const shared of ["Return one short Markdown body", "I will copy your text", "import it there", "Do not fetch or write this private draft", "https://tomola.example/drafts/9"]) expect(prompt).not.toContain(shared);
    for (const task of AI_WRITE_TASKS.filter((t) => t !== "question")) expect(aiWritePrompt({ task, lang: "en", body, returnUrl: "https://tomola.example/drafts/9" })).toContain("Return one short Markdown body");
    // It still fits the encoded address of both built-in choices for a short note.
    for (const provider of ["chatgpt", "claude"] as const) expect(aiWriteDestination({ provider }, prompt).url).not.toBeNull();
  });

  it("uses the complete encoded URL boundary and never truncates long text", () => {
    const prefix = "https://chatgpt.com/?q=";
    expect(aiWriteDestination({ provider: "chatgpt" }, "x".repeat(2000 - prefix.length)).url).toHaveLength(2000);
    expect(aiWriteDestination({ provider: "chatgpt" }, "x".repeat(2001 - prefix.length))).toMatchObject({ url: null, launchUrl: "https://chatgpt.com/?q=" });
    const prompt = aiWritePrompt({ task: "revise", lang: "ja", body: "日本語".repeat(1000), returnUrl: "https://tomola.example/drafts/1" });
    expect(aiWriteDestination({ provider: "claude" }, prompt).url).toBeNull();
    expect(prompt).toContain("日本語".repeat(1000));
    // The template itself may contain Unicode too; count its serialized URL.
    expect(aiWriteDestination({ provider: "custom", template: `https://ai.example/${"日".repeat(300)}?q={prompt}` }, "short")).toEqual({ url: null, launchUrl: null });
  });

  it("rejects unsafe templates and does not guess a destination for an empty custom hostname", () => {
    expect(aiWriteDestination({ provider: "custom", template: "javascript:{prompt}" }, "text")).toEqual({ url: null, launchUrl: null });
    expect(aiWriteDestination({ provider: "custom", template: "https://{prompt}/" }, "x".repeat(2000))).toEqual({ url: null, launchUrl: null });
    const prompt = aiWritePrompt({ task: "translate", lang: "en", body: "Only this excerpt", returnUrl: "https://tomola.example/drafts/1" });
    expect(prompt).toContain("Translate the excerpt");
    expect(prompt).not.toContain("secret title");
  });
});

it("appends complete Markdown to the current body, preserving sources, comments and candidate frontmatter", () => {
  const body = "[Source](https://example.org/a)\n\nMy comment.\n\nA later note.";
  const candidate = "---\nlang: fr\ntitle: AI title\n---\n```md\nAI text\n```";
  expect(appendAiText(body, candidate)).toEqual({ ok: true, body: `${body}\n\n${candidate}` });
  expect(appendAiText("x".repeat(49997), "x")).toMatchObject({ ok: true });
  expect(appendAiText("x".repeat(49998), "x")).toEqual({ ok: false, error: "body_too_long" });
  expect(appendAiText(body, " \n")).toEqual({ ok: false, error: "empty" });
});

it("conditionally updates only one editor's version and never publishes stale or deleted drafts", async () => {
  const db = await createTestDb();
  await addMember(db, "drafter", "drafter");
  await addMember(db, "other", "other");
  const created = await createDraft(db, "drafter", { kind: "topic", body: "Source and note", lang: "ja" });
  if (!created.ok) throw new Error(created.error);
  expect(await updateDraft(db, "other", created.id, { body: "Stolen", lang: "ja" }, { expectedVersion: 1 })).toEqual({ ok: false, error: "not_found" });
  const results = await Promise.all(["First editor", "Second editor"].map(body => updateDraft(db, "drafter", created.id, { body, lang: "ja" }, { expectedVersion: 1 })));
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.filter(r => !r.ok)).toEqual([{ ok: false, error: "draft_conflict" }]);
  expect((await getDraft(db, "drafter", created.id))?.version).toBe(2);
  expect(await db.select().from(entries)).toHaveLength(0);
  expect(await db.select().from(jobs)).toHaveLength(0);
  await db.transaction(async tx => {
    const save = await updateDraft(tx, "drafter", created.id, { body: "Stale publication", lang: "ja" }, { expectedVersion: 1 });
    if (save.ok) await publishDraft(tx, "drafter", created.id);
    expect(save).toEqual({ ok: false, error: "draft_conflict" });
  });
  expect(await db.select().from(entries)).toHaveLength(0);
  await db.delete(drafts).where(eq(drafts.id, created.id));
  expect(await updateDraft(db, "drafter", created.id, { body: "Gone", lang: "ja" }, { expectedVersion: 2 })).toEqual({ ok: false, error: "not_found" });
});
