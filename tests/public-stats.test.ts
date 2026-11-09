import { shellLabels } from "~/lib/shell-labels.server";
import { createElement } from "react";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatMessages, chatMessageTranslations, entries, qualityMetricState, translationEvalPoints, translationEvalRuns, translationEvalTexts, translationReports, translations, villages } from "~/lib/db/schema";
import type { Db } from "~/lib/db/client.server";
import { evaluationHistory } from "~/lib/eval/metrics.server";
import { translationInventory, translationQualitySignals } from "~/lib/eval/signals.server";
import { collectPublicStats, createPublicStatsReader, PUBLIC_STATS_TTL_MS, publicCount, publicRate, selectPublicStats } from "~/lib/public-stats.server";
import { publicStatsMarkdown } from "~/lib/public-stats-view";
import { observationWeeks, reportStats } from "~/lib/metrics.server";
import { createTopic } from "~/lib/entries.server";
import Stats, { loader as htmlLoader } from "~/routes/stats";
import { loader as markdownLoader } from "~/routes/stats-md";
import { m } from "~/paraglide/messages.js";
import { OPERATOR_ONLY_KEYS } from "~/lib/i18n/operator-keys";
import { formatTime } from "~/lib/time-format";
import { SiteFooter } from "~/components/site-footer";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { renderInRouter } from "./helpers/render-in-router";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const now = new Date("2026-11-02T12:00:00Z");
afterEach(() => { vi.unstubAllEnvs(); setTestLocale("en"); });

function sample() {
  const starts = observationWeeks(now);
  return selectPublicStats({ now, history: [], inventory: { weekly: starts.map(weekStart => ({ weekStart, count: 3 })), pairs: 4, pairsFrom: "2026-10-05T12:00:00Z" },
    replies: starts.map(weekStart => ({ weekStart, topics: 10, crossArea: 2, rate: 0.2, people: 1 })),
    insightful: starts.map(weekStart => ({ weekStart, observed: true, numerator: 5, denominator: 10, people: 4, rate: 0.5 })),
    active: starts.map(weekStart => ({ weekStart, members: 4 })),
    retention: starts.map(cohortWeek => ({ cohortWeek, observed: false, numerator: 0, denominator: 0, people: 0 })),
    reports: starts.map(weekStart => ({ weekStart, total: 2, eligible: 4, corrected: 1, since: starts[0].toISOString() })),
  });
}

describe("public statistics disclosure", () => {
  it("includes publicly used message keys in translation review", () => {
    const view = fs.readFileSync(new URL("../app/lib/public-stats-view.ts", import.meta.url), "utf8");
    for (const [, key] of view.matchAll(/\bm\.(\w+)/g)) expect(OPERATOR_ONLY_KEYS.has(key), key).toBe(false);
  });
  it("withholds every small count, including people, while allowing zero and five", () => {
    for (const n of [1, 2, 3, 4]) {
      expect(publicCount(n)).toBeNull();
      expect(publicRate(n, 10, n)).toEqual({ numerator: null, denominator: 10, rate: null, people: null });
      expect(publicRate(0, n).rate).toBeNull();
      expect(publicRate(n, n).rate).toBeNull();
    }
    expect(publicCount(0)).toBe(0);
    expect(publicCount(5)).toBe(5);
    expect(publicRate(0, 5, 0)).toEqual({ numerator: 0, denominator: 5, rate: 0, people: 0 });
    expect(publicRate(5, 5).rate).toBe(1);
    expect(publicRate(0, 0).rate).toBeNull();
  });

  it("sends only suppressed aggregate data to both renderers", async () => {
    setTestLocale("en");
    const snapshot = sample();
    expect(snapshot.translations.every(row => row.count === null)).toBe(true);
    expect(snapshot.languagePairs.count).toBeNull();
    expect(snapshot.replies[0]).toMatchObject({ numerator: null, people: null, rate: null });
    expect(snapshot.reports[0]).toMatchObject({ count: null, correction: { numerator: null, denominator: null, rate: null } });
    expect(snapshot.active[0].count).toBeNull();
    const html = await renderInRouter(() => createElement(Stats, { loaderData: snapshot } as never), "/stats");
    const markdown = publicStatsMarkdown(snapshot);
    for (const output of [html, markdown]) {
      expect(output).toContain(m.stats_small());
      expect(output).toContain(m.stats_unmeasured());
      expect(output).not.toContain("20.0%");
      expect(output).toContain("50.0%");
      for (const label of [m.metrics_ai_title(), m.metrics_dir_title(), m.metrics_distance_title(), m.metrics_first_stances_title(), m.metrics_langs_title(), m.metrics_via_title()]) {
        expect(output).not.toContain(label);
      }
    }
  });

  it("formats screen timestamps with the shared clock while retaining ISO timestamps in Markdown", async () => {
    const snapshot = sample();
    snapshot.evaluation = { finishedAt: "2026-10-30T12:30:00Z", setVersion: "fixture", translator: { provider: "gemini", model: "fixture" },
      judge: { provider: "gemini", model: "fixture" }, sameProvider: true, configurationChanged: false, pairs: [], categories: [] };
    const html = await renderInRouter(() => createElement(Stats, { loaderData: snapshot } as never), "/stats");
    const visibleTimes = [...html.matchAll(/<time\b[^>]*>(.*?)<\/time>/gs)].map(match => match[1]);
    expect(visibleTimes).toHaveLength(4);
    expect(visibleTimes.every(text => !/\d{4}-\d{2}-\d{2}T/.test(text))).toBe(true);
    const markdown = publicStatsMarkdown(snapshot);
    for (const iso of [snapshot.generatedAt, snapshot.evaluation.finishedAt!, snapshot.languagePairs.from, snapshot.reports[0].since]) {
      const shown = formatTime(iso, { now: new Date(), timeZone: "UTC", locale: "en", style: "short", zoneLabel: true }).text;
      expect(visibleTimes.some(text => text.includes(shown))).toBe(true);
      expect(markdown).toContain(iso);
    }
    expect(html).toContain(m.stats_denominator());
    expect(markdown).toContain(m.stats_denominator());
  });

  it.each([[false, false, false], [false, true, true], [true, false, true], [true, true, true]])(
    "shows the footer entry only to members or public readers (member=%s, public=%s)", async (member, publicReading, shown) => {
      const html = await renderInRouter(() => createElement(SiteFooter, { labels: shellLabels(), sourceUrl: null, member, publicReading, statsLabel: m.stats_title() }));
      expect(html.includes('href="/stats"')).toBe(shown);
    });

  it("shares concurrent collection for one hour, separates databases, and retries failures", async () => {
    let time = now.getTime();
    const collect = vi.fn(async () => sample());
    const read = createPublicStatsReader(collect, () => time);
    const db = {} as Db, other = {} as Db;
    const first = read(db);
    expect(read(db)).toBe(first);
    await first;
    time += PUBLIC_STATS_TTL_MS - 1;
    expect(read(db)).toBe(first);
    time++;
    await read(db);
    expect(collect).toHaveBeenCalledTimes(2);
    await read(other);
    expect(collect).toHaveBeenCalledTimes(3);
    const failure = vi.fn().mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue(sample());
    const retry = createPublicStatsReader(failure, () => time);
    await expect(retry(db)).rejects.toThrow("database unavailable");
    await expect(retry(db)).resolves.toEqual(sample());
    expect(failure).toHaveBeenCalledTimes(2);
  });
});

it("keeps operator report and correction totals unchanged when selecting a weekly cohort", async () => {
  const db = await createTestDb();
  await addMember(db, "stats_author", "stats_author");
  const result = await createTopic(db, "stats_author", { lang: "ja", body: "Statistics fixture" });
  if (!result.ok) throw new Error(result.error);
  await db.update(qualityMetricState).set({ startedAt: new Date("2026-09-01Z") });
  await db.insert(translationReports).values([
    { entryId: result.id, lang: "en", sourceLang: "ja", field: "body", createdAt: new Date("2026-10-26Z"), correctedAt: now, resolvedAt: now, status: "resolved" },
    { entryId: result.id, lang: "en", sourceLang: "ja", field: "title", createdAt: new Date("2026-10-27Z"), resolvedAt: now, status: "resolved" },
    { entryId: result.id, lang: "en", sourceLang: "ja", field: "body", createdAt: new Date("2026-10-25Z") },
  ]);
  const period = { from: new Date("2026-10-26Z"), to: new Date("2026-11-02Z") };
  const before = await reportStats(db), signals = await translationQualitySignals(db);
  expect(before).toMatchObject({ total: 3, resolved: 2 });
  expect(await reportStats(db, period)).toMatchObject({ total: 2, resolved: 2 });
  const weekly = await translationQualitySignals(db, period);
  expect(weekly.translations[0]).toMatchObject({ reports: 2, corrected: 1, correctionRate: 0.5 });
  expect(await reportStats(db)).toEqual(before);
  expect(await translationQualitySignals(db)).toEqual(signals);
});

it("counts surviving primary translation records in UTC weeks and distinct recently updated pairs only", async () => {
  const db = await createTestDb();
  await addMember(db, "inventory", "inventory");
  const result = await createTopic(db, "inventory", { lang: "ja", body: "Inventory fixture" });
  if (!result.ok) throw new Error(result.error);
  await db.insert(translations).values([
    { entryId: result.id, field: "body", lang: "en", kind: "primary", text: "one", createdAt: new Date("2026-10-25T23:59:59Z"), updatedAt: new Date("2026-10-25T23:59:59Z") },
    { entryId: result.id, field: "title", lang: "en", kind: "primary", text: "two", createdAt: new Date("2026-10-26Z"), updatedAt: new Date("2026-10-26Z") },
    { entryId: result.id, field: "body", lang: "fr", kind: "secondary", text: "excluded", createdAt: now },
    { entryId: result.id, field: "body", lang: "de", kind: "primary", text: "untranslated", flags: ["untranslated"], createdAt: new Date("2026-10-26Z") },
    { entryId: result.id, field: "body", lang: "ko", kind: "primary", text: "old, recently updated", createdAt: new Date("2026-01-01Z"), updatedAt: new Date("2026-10-26Z") },
  ]);
  const inventory = await translationInventory(db, now);
  expect(inventory.weekly.slice(-3).map(row => row.count)).toEqual([1, 1, 0]);
  expect(inventory.pairs).toBe(2);
});

it("excludes unreadable posts and unavailable chat messages while keeping chat out of language-pair counts", async () => {
  const db = await createTestDb();
  await addMember(db, "visibility", "visibility");
  const at = new Date("2026-10-26T12:00:00Z");
  const [open, closed, slugless] = await db.insert(villages).values([
    { kind: "open", slug: "stats-visible" }, { kind: "closed", slug: "stats-closed" }, { kind: "open", slug: null },
  ]).returning();
  const [visible, hidden, deleted, closedTopic, sluglessTopic] = await db.insert(entries).values([
    { kind: "topic", authorId: "visibility", lang: "ja", body: "Visible", villageId: open.id },
    { kind: "topic", authorId: "visibility", lang: "ja", body: "Hidden", hiddenAt: at },
    { kind: "topic", authorId: "visibility", lang: "ja", body: "Deleted", deletedAt: at },
    { kind: "topic", authorId: "visibility", lang: "ja", body: "Closed", villageId: closed.id },
    { kind: "topic", authorId: "visibility", lang: "ja", body: "Unaddressable", villageId: slugless.id },
  ]).returning();
  const [visibleReply, hiddenReply, replyToHidden, replyToDeleted, replyToClosed] = await db.insert(entries).values([
    { kind: "reply", authorId: "visibility", lang: "ja", body: "Visible reply", threadId: visible.id },
    { kind: "reply", authorId: "visibility", lang: "ja", body: "Hidden reply", threadId: visible.id, hiddenAt: at },
    { kind: "reply", authorId: "visibility", lang: "ja", body: "Hidden parent", threadId: hidden.id },
    { kind: "reply", authorId: "visibility", lang: "ja", body: "Deleted parent", threadId: deleted.id },
    { kind: "reply", authorId: "visibility", lang: "ja", body: "Closed parent", threadId: closedTopic.id },
  ]).returning();
  await db.insert(translations).values([visible, visibleReply, hidden, deleted, closedTopic, sluglessTopic, hiddenReply, replyToHidden, replyToDeleted, replyToClosed].map((entry, i) => ({
    entryId: entry.id, field: "body", lang: i < 2 ? "en" : "fr", kind: "primary", text: "Translation", createdAt: at, updatedAt: at,
  })));
  const messages = await db.insert(chatMessages).values([
    { villageId: open.id, body: "Visible chat" }, { villageId: open.id, body: "Hidden chat", hiddenAt: at },
    { villageId: open.id, body: "", deletedAt: at }, { villageId: closed.id, body: "Closed chat" },
    { villageId: slugless.id, body: "Unaddressable chat" }, { villageId: open.id, body: "Pending translation" },
  ].map((message, i) => ({ ...message, authorId: "visibility", lang: "fr", createdSeq: i + 1, changedSeq: i + 1, createdAt: at }))).returning();
  await db.insert(chatMessageTranslations).values(messages.map((message, i) => ({ messageId: message.id, lang: "de", state: i === 5 ? "pending" as const : "ready" as const,
    sourceHash: "a".repeat(64), text: i === 5 ? null : "Chat translation", createdAt: at, updatedAt: at })));
  const inventory = await translationInventory(db, now);
  expect(inventory.weekly.slice(-2).map(row => row.count)).toEqual([3, 0]);
  expect(inventory.pairs).toBe(1);
  await db.update(chatMessages).set({ deletedAt: now, body: "" }).where(eq(chatMessages.id, messages[0].id));
  expect((await translationInventory(db, now)).weekly.slice(-2).map(row => row.count)).toEqual([2, 0]);
});

it("selects a real completed evaluation beyond thirty newer fake runs without changing operator history", async () => {
  const db = await createTestDb();
  const model = { provider: "gemini", model: "fixture-translator", thinking: "off", promptVersion: "fixture" };
  const run = { setVersion: "public-eval", setHash: "one", translator: model, judge: model, glossary: [], sameProvider: true, status: "completed" as const, finishedAt: now, costUsdMicro: 123456789 };
  await db.insert(translationEvalRuns).values([
    { ...run, id: "real-old", setHash: "older-set", startedAt: new Date("2026-10-01Z") },
    { ...run, id: "real-latest", startedAt: new Date("2026-10-02Z") },
    ...Array.from({ length: 31 }, (_, i) => ({ ...run, id: `fake-${i}`, setVersion: "PRIVATE_FAKE", translator: { ...model, provider: "fake" }, startedAt: new Date("2026-10-03Z") })),
    { ...run, id: "failed", setVersion: "PRIVATE_FAILED", status: "failed" as const, startedAt: now },
    { ...run, id: "fake-judge", setVersion: "PRIVATE_FAKE_JUDGE", judge: { ...model, provider: "fake" }, startedAt: now },
  ]);
  await db.insert(translationEvalTexts).values({ runId: "real-latest", caseId: "check", from: "ja", to: "en", category: "negation", source: "PRIVATE_EVAL_TEXT" });
  await db.insert(translationEvalPoints).values({ runId: "real-latest", caseId: "check", to: "en", checkId: "meaning", description: "Check", kind: "meaning", preserved: false, severe: true, reason: "PRIVATE_REASON" });
  const operatorBefore = await evaluationHistory(db);
  const history = await evaluationHistory(db, { publicOnly: true });
  expect(history.map(row => row.id)).toEqual(["real-latest", "real-old"]);
  expect(history[0]).toMatchObject({ configurationChanged: true, previousId: "real-old", sameProvider: true });
  expect(await evaluationHistory(db)).toEqual(operatorBefore);
  const snapshot = await collectPublicStats(db, now);
  expect(snapshot.evaluation?.pairs[0]).toMatchObject({ total: 1, preserved: 0, severe: 1, rate: 0 });
  const html = await renderInRouter(() => createElement(Stats, { loaderData: snapshot } as never), "/stats");
  for (const output of [JSON.stringify(snapshot), html, publicStatsMarkdown(snapshot)]) {
    expect(output).toContain("fixture-translator");
    for (const forbidden of ["PRIVATE_", "costUsd", "123456789", "fake-", "authorId", "entryId", "crossAreaDirectionMatrix", "stanceDistanceByAreaPair", "questionLangComposition"]) expect(output).not.toContain(forbidden);
  }
});

it("applies shared reading gates before cached HTML and Markdown, including invalid credentials and HEAD", async () => {
  const harness = await setupRouteHarness();
  try {
    await harness.signIn("stats_member");
    vi.stubEnv("PUBLIC_READING", "");
    expect(await harness.outcome(() => htmlLoader(harness.args(harness.request("/stats"))))).toMatchObject({ status: 302 });
    expect((await markdownLoader({ request: harness.request("/stats.md") })).status).toBe(401);
    expect(await htmlLoader(harness.args(harness.request("/stats", { as: "stats_member" })))).toHaveProperty("generatedAt");
    expect((await markdownLoader({ request: harness.request("/stats.md", { as: "stats_member" }) })).status).toBe(200);
    expect((await markdownLoader({ request: harness.request("/stats.txt") })).status).toBe(401);
    const memberMd = await markdownLoader({ request: harness.request("/stats.md", { as: "stats_member" }) });
    const memberTxt = await markdownLoader({ request: harness.request("/stats.txt", { as: "stats_member" }) });
    expect(memberTxt.status).toBe(200);
    expect(await memberTxt.text()).toBe(await memberMd.text());
    vi.stubEnv("PUBLIC_READING", "1");
    const snapshot = await htmlLoader(harness.args(harness.request("/stats")));
    expect(snapshot).toHaveProperty("generatedAt");
    expect((await markdownLoader({ request: harness.request("/stats.md") })).status).toBe(200);
    const publicMd = await markdownLoader({ request: harness.request("/stats.md") });
    const publicTxt = await markdownLoader({ request: harness.request("/stats.txt") });
    expect(publicTxt.status).toBe(200);
    expect(await publicTxt.text()).toBe(await publicMd.text());
    expect((await markdownLoader({ request: harness.request("/stats.md?k=invalid") })).status).toBe(401);
    expect((await markdownLoader({ request: harness.request("/stats.md", { headers: { Authorization: "Bearer invalid" } }) })).status).toBe(401);
    const head = await markdownLoader({ request: new Request("http://localhost:5173/stats.md", { method: "HEAD" }) });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("private, no-store");
    vi.stubEnv("PUBLIC_READING", "");
    expect((await markdownLoader({ request: harness.request("/stats.md") })).status).toBe(401);
    expect((await markdownLoader({ request: harness.request("/stats.txt") })).status).toBe(401);
    expect(await harness.outcome(() => htmlLoader(harness.args(harness.request("/stats"))))).toMatchObject({ status: 302 });
  } finally { harness.restore(); }
});
