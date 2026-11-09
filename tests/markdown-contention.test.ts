import fs from "node:fs";
import { eq } from "drizzle-orm";
import { createStaticHandler } from "react-router";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { setupRouteHarness } from "./helpers/route-harness";
import { markdownFixture } from "./helpers/markdown-fixture";
import { createTopic, getThread } from "~/lib/entries.server";
import { MarkdownBusyError, setMarkdownExecutorForTests, withMarkdownScope } from "~/lib/markdown-budget.server";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { drafts, entries, entryReferences, jobs, signingChallenges } from "~/lib/db/schema";
import { createDraft, getDraft } from "~/lib/drafts.server";
import { resolveSourceMentions } from "~/lib/mentions.server";
import { plainExcerpt } from "~/lib/plain-text.server";
import { fixEntry } from "~/lib/moderation.server";
import { setStance } from "~/lib/stances.server";
import { createAppeal, decideAppeal } from "~/lib/appeals.server";

const cleanups: Array<() => Promise<void>> = [];
let shared: Awaited<ReturnType<typeof setupRouteHarness>>;
beforeAll(async () => {
  shared = await setupRouteHarness();
  for (const name of ["writer", "reader", "opal", "rina"]) await shared.signIn(name, { homeArea: "en" });
});
afterAll(() => shared.restore());
afterEach(async () => { vi.restoreAllMocks(); for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function setup() {
  const h = shared;
  const f = markdownFixture(); const p = f.executor({ writeWaitMs: 100, backgroundWaitMs: 3000 });
  await setMarkdownExecutorForTests(p);
  cleanups.push(async () => { f.remove(); await p.stop(); });
  return { h, f, p };
}
async function fill(f: ReturnType<typeof markdownFixture>, p: ReturnType<ReturnType<typeof markdownFixture>["executor"]>) {
  const one = f.marker("one"), two = f.marker("two");
  const a = p.run("hold", [one]); await f.started(one);
  const b = p.run("hold", [two]); await f.started(two);
  return { one, two, release: async () => { f.release(one); f.release(two); await Promise.all([a, b]); } };
}

it("returns a busy post submission with status 503 and the original form values", async () => {
  const { h, f, p } = await setup(); const holds = await fill(f, p);
  try {
    const { action } = await import("~/routes/topic-new");
    const result = await withMarkdownScope("write", h.ids.writer, () => h.outcome(() => action(h.args(h.request("/t/new", { as: "writer", form: { title: "Title", body: "A normal **post**.", lang: "en" } })))));
    expect(result).toMatchObject({ status: 503, value: { data: { error: "busy", values: { title: "Title", body: "A normal **post**.", lang: "en" } } } });
    expect(await h.db.select().from(entries)).toHaveLength(0);
  } finally { await holds.release(); }
}, 20_000);

it("returns HTTP 503 from a preview resource when both Markdown workers are occupied", async () => {
  const { h, f, p } = await setup(); const holds = await fill(f, p);
  try {
    const { action } = await import("~/routes/preview");
    const handler = createStaticHandler([{ id: "preview", path: "/preview", action: args => action(args as Parameters<typeof action>[0]) }]);
    const result = await handler.query(h.request("/preview", { as: "writer", form: { body: "An ordinary **preview**.", lang: "en" } }));
    // An Error's status property alone does not set React Router's HTTP status.
    expect(result instanceof Response ? result.status : result.statusCode).toBe(503);
    if (!(result instanceof Response)) expect(result.actionHeaders.preview.get("Retry-After")).toBe("1");
  } finally { await holds.release(); }
}, 20_000);

it.each(["create", "update"])("returns HTTP 503 from a busy AI draft %s without saving the attempted text", async kind => {
  const { h, f, p } = await setup();
  const existing = kind === "update" ? await createDraft(h.db, h.ids.writer, { kind: "topic", body: "Original draft body", lang: "en" }) : null;
  if (existing && !existing.ok) throw new Error("Draft fixture failed");
  const before = await h.db.select().from(drafts);
  const holds = await fill(f, p);
  try {
    const { action } = await import("~/routes/ai-draft");
    const handler = createStaticHandler([{ id: "ai-draft", path: "/drafts/ai-write", action: args => action(args as Parameters<typeof action>[0]) }]);
    const form = { ownerId: h.ids.writer, body: `Busy AI draft ${kind}`, lang: "en", ...(existing?.ok ? { draftId: String(existing.id), version: "1" } : {}) };
    const result = await handler.query(h.request("/drafts/ai-write", { as: "writer", form }));
    expect(result instanceof Response ? result.status : result.statusCode).toBe(503);
    if (!(result instanceof Response)) {
      expect(result.actionData?.["ai-draft"]).toEqual({ error: "rate_limited" });
      expect(result.actionHeaders["ai-draft"].get("Retry-After")).toBe("1");
      expect(result.actionHeaders["ai-draft"].get("Cache-Control")).toBe("no-store");
    }
    expect(await h.db.select().from(drafts)).toEqual(before);
    if (existing?.ok) expect((await getDraft(h.db, h.ids.writer, existing.id))?.body).toBe("Original draft body");
  } finally { await holds.release(); }
}, 20_000);

it.each(["preview", "challenge"])("returns HTTP 503 from a busy signing %s without issuing a challenge", async intent => {
  const { h, f, p } = await setup(); const holds = await fill(f, p);
  try {
    const { action } = await import("~/routes/signing");
    const before = await h.db.select().from(signingChallenges);
    const handler = createStaticHandler([{ id: "signing", path: "/signing", action: args => action(args as Parameters<typeof action>[0]) }]);
    const request = new Request(h.request("/signing", { as: "writer" }), { method: "POST", body: JSON.stringify({ intent, pathname: "/t/new", fields: [["body", `Busy signing ${intent}`], ["lang", "en"]], previewHash: "a".repeat(64) }) });
    request.headers.set("Content-Type", "application/json");
    const result = await handler.query(request);
    expect(result instanceof Response ? result.status : result.statusCode).toBe(503);
    if (!(result instanceof Response)) {
      expect(result.actionData?.signing).toEqual({ error: "rate_limited" });
      expect(result.actionHeaders.signing.get("Retry-After")).toBe("1");
      expect(result.actionHeaders.signing.get("Cache-Control")).toBe("no-store");
    }
    expect(await h.db.select().from(signingChallenges)).toEqual(before);
  } finally { await holds.release(); }
}, 20_000);

it("returns HTTP 503 from the Markdown why page if its worker initialization is unavailable", async () => {
  const startup = await import("~/lib/markdown-startup.server");
  vi.spyOn(startup, "initializeSiteMarkdown").mockRejectedValue(new MarkdownBusyError("worker"));
  const { loader } = await import("~/routes/why-md");
  const handler = createStaticHandler([{ id: "why-md", path: "/why.md", loader: args => loader(args as Parameters<typeof loader>[0]) }]);
  const result = await handler.query(shared.request("/why.md"));
  expect(result instanceof Response ? result.status : result.statusCode).toBe(503);
  if (!(result instanceof Response)) expect(result.loaderHeaders["why-md"].get("Retry-After")).toBe("1");
});

it("keeps the reply form when a native busy POST revalidates a titleless topic", async () => {
  const { h, f, p } = await setup();
  const topic = await createTopic(h.db, h.ids.reader, { lang: "en", body: "An ordinary **titleless** topic." });
  if (!topic.ok) throw new Error("control failed");
  const holds = await fill(f, p);
  try {
    const route = await import("~/routes/topic");
    const handler = createStaticHandler([{ id: "root", path: "/", children: [{ id: "topic", path: "t/:id", loader: args => route.loader(args as Parameters<typeof route.loader>[0]), action: args => route.action(args as Parameters<typeof route.action>[0]) }] }]);
    // The root request middleware scopes the entire native submit, including
    // React Router's internal GET loader revalidation, as a write.
    const result = await withMarkdownScope("write", undefined, () => handler.query(h.request(`/t/${topic.id}`, { as: "writer", form: { body: "Retain my **reply**.", lang: "en" } })));
    if (result instanceof Response) throw new Error("Expected page data");
    expect(result.errors).toBeNull();
    expect(result.statusCode).toBe(503);
    expect(result.actionData).toMatchObject({ topic: { error: "busy", input: { body: "Retain my **reply**.", lang: "en" } } });
    expect(result.loaderData.topic).toHaveProperty("topic.id", topic.id);
  } finally { await holds.release(); }
}, 20_000);

it("retains a moderator's translation correction on transient failure", async () => {
  const { h } = await setup();
  const session = await import("~/lib/auth/session.server");
  vi.spyOn(session, "requireModerator").mockResolvedValue({ db: h.db, user: { id: h.ids.opal }, scope: { operator: true, langs: [] } } as never);
  const reports = await import("~/lib/translation-reports.server");
  vi.spyOn(reports, "resolveReportWithHumanTranslation").mockRejectedValue(new MarkdownBusyError());
  const route = await import("~/routes/admin-translations");
  expect(await h.outcome(() => route.action(h.args(h.request("/admin/translations", { as: "opal", form: { reportId: "1", text: "Keep my correction." } }))))).toMatchObject({ status: 503, value: { data: { error: "rate_limited", text: "Keep my correction.", reportId: 1 } } });
});

it("retains an appeal decision note on transient restoration failure", async () => {
  const { h } = await setup();
  const session = await import("~/lib/auth/session.server");
  vi.spyOn(session, "requireModerator").mockResolvedValue({ db: h.db, user: { id: h.ids.rina }, scope: { operator: true, langs: [] } } as never);
  const appeals = await import("~/lib/appeals.server");
  vi.spyOn(appeals, "decideAppeal").mockRejectedValue(new MarkdownBusyError());
  const route = await import("~/routes/mod-appeals");
  expect(await h.outcome(() => route.action(h.args(h.request("/mod/appeals", { as: "rina", form: { appealId: "1", intent: "overturn", note: "Keep my decision note." } }))))).toMatchObject({ status: 503, value: { data: { error: "rate_limited", note: "Keep my decision note.", appealId: 1 } } });
});

it("a job waits for the worker before calling its engine and preserves mention protection", async () => {
  const { h, f, p } = await setup();
  const topic = await createTopic(h.db, h.ids.writer, { lang: "en", body: "Hello @reader." });
  if (!topic.ok) throw new Error("control failed");
  await h.db.delete(jobs); await enqueue(h.db, "markdown-test");
  const holds = await fill(f, p); const engine = vi.fn(async () => "Hello reader.");
  const running = runDueJobs(h.db, { "markdown-test": async () => {
    const source = await resolveSourceMentions(h.db, "Hello @reader.", topic.id);
    expect(source.mentions).toEqual(["@reader"]);
    await engine(); expect(await plainExcerpt("Hello **reader**.", 100)).toBe("Hello reader.");
  } }, { logger: { warn() {}, error() {} } });
  setTimeout(() => { f.release(holds.one); f.release(holds.two); }, 400);
  const stats = await running;
  expect(stats.done).toBe(1); expect(engine).toHaveBeenCalledTimes(1);
  await holds.release();
}, 20_000);

it("an appeal rolls back rather than saving lost references after a transient failure", async () => {
  const { h, f } = await setup();
  const other = await createTopic(h.db, h.ids.reader, { lang: "en", body: "Other topic." });
  if (!other.ok) throw new Error("control failed");
  const original = `Original @reader [discussion](/t/${other.id}).`;
  const question = await createTopic(h.db, h.ids.writer, { lang: "en", title: "Question", body: original, asksStance: true });
  if (!question.ok) throw new Error("question failed");
  expect((await setStance(h.db, h.ids.reader, { questionId: question.id, position: "agree", expectedVersion: 0 })).ok).toBe(true);
  const beforeFix = (await getThread(h.db, question.id))!.topic;
  const fixed = await fixEntry(h.db, { id: h.ids.opal, scope: { operator: true, langs: [] } }, { entryId: question.id, sourceHash: beforeFix.sourceHash!, title: "Corrected", body: `Corrected @reader [discussion](/t/${other.id}).`, note: "Correction" });
  if (!fixed.ok) throw new Error("fix failed");
  const appeal = await createAppeal(h.db, h.ids.writer, fixed.actionId, "Restore original");
  if (!appeal.ok) throw new Error("appeal failed");
  const saved = (await h.db.select().from(entries).where(eq(entries.id, question.id)))[0];
  const references = await h.db.select().from(entryReferences).where(eq(entryReferences.sourceEntryId, question.id));
  const crashFile = f.marker("crash");
  const failed = markdownFixture({ crashFile, crashOperation: "parseEntryReferences" });
  const p = failed.executor(); await setMarkdownExecutorForTests(p);
  cleanups.push(async () => { failed.remove(); await p.stop(); });
  await expect(withMarkdownScope("write", h.ids.rina, () => decideAppeal(h.db, { id: h.ids.rina, scope: { operator: true, langs: [] } }, appeal.id, { decision: "overturned", note: "Restore" }))).rejects.toMatchObject({ status: 503 });
  expect((await h.db.select().from(entries).where(eq(entries.id, question.id)))[0]).toEqual(saved);
  expect(await h.db.select().from(entryReferences).where(eq(entryReferences.sourceEntryId, question.id))).toEqual(references);
}, 20_000);
