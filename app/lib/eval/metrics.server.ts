import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { translationEvalPoints as points, translationEvalRuns as runs, translationEvalTexts as texts } from "~/lib/db/schema";

export async function evaluationHistory(db: Db, options: { publicOnly?: boolean } = {}) {
  const history = await db.select({ id: runs.id, startedAt: runs.startedAt, finishedAt: runs.finishedAt, setVersion: runs.setVersion, setHash: runs.setHash,
    translator: runs.translator, glossaryVersion: runs.glossaryVersion, judge: runs.judge, sameProvider: runs.sameProvider, calls: runs.calls, costUsdMicro: runs.costUsdMicro, status: runs.status,
  }).from(runs).where(options.publicOnly ? and(eq(runs.status, "completed"), sql`${runs.translator}->>'provider' <> 'fake'`, sql`${runs.judge}->>'provider' <> 'fake'`) : undefined)
    .orderBy(desc(runs.startedAt), desc(runs.id)).limit(options.publicOnly ? 2 : 30);
  if (!history.length) return [];
  const groups = await db.select({ runId: points.runId, from: texts.from, to: texts.to, category: texts.category, total: sql<number>`count(*)::int`, preserved: sql<number>`count(*) filter (where ${points.preserved})::int`, severe: sql<number>`count(*) filter (where ${points.severe})::int` })
    .from(points).innerJoin(texts, and(eq(texts.runId, points.runId), eq(texts.caseId, points.caseId), eq(texts.to, points.to))).where(inArray(points.runId, history.map(r => r.id)))
    .groupBy(points.runId, texts.from, texts.to, texts.category);
  return history.map((run, index) => {
    const fake = run.translator.provider === "fake" || run.judge.provider === "fake";
    const previous = options.publicOnly ? history[index + 1] : history.slice(index + 1).find(r => r.status === "completed" && r.setHash === run.setHash && (r.translator.provider === "fake" || r.judge.provider === "fake") === fake);
    const configuration = (r: typeof run) => JSON.stringify([r.translator.provider, r.translator.model, r.translator.thinking, r.translator.promptVersion,
      r.judge.provider, r.judge.model, r.judge.thinking, r.judge.promptVersion, r.glossaryVersion]);
    const cells = groups.filter(g => g.runId === run.id);
    const aggregate = (by: "pair" | "category") => {
      const sums = new Map<string, { label: string; total: number; preserved: number; severe: number; previousTotal: number; previousPreserved: number; previousSevere: number }>();
      for (const g of [...cells, ...groups.filter(g => g.runId === previous?.id)]) {
        const label = by === "pair" ? `${g.from} → ${g.to}` : g.category;
        const cell = sums.get(label) ?? { label, total: 0, preserved: 0, severe: 0, previousTotal: 0, previousPreserved: 0, previousSevere: 0 };
        if (g.runId === run.id) { cell.total += Number(g.total); cell.preserved += Number(g.preserved); cell.severe += Number(g.severe); }
        else { cell.previousTotal += Number(g.total); cell.previousPreserved += Number(g.preserved); cell.previousSevere += Number(g.severe); }
        sums.set(label, cell);
      }
      return [...sums.values()].filter(c => c.total > 0).map(c => ({ label: c.label, total: c.total, preserved: c.preserved, severe: c.severe,
        rate: run.status === "completed" ? c.preserved / c.total : null,
        delta: run.status === "completed" && c.previousTotal ? c.preserved / c.total - c.previousPreserved / c.previousTotal : null,
        severeDelta: run.status === "completed" && c.previousTotal ? c.severe - c.previousSevere : null,
      })).sort((a, b) => a.label.localeCompare(b.label));
    };
    return { id: run.id, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null, setVersion: run.setVersion, setHash: run.setHash,
      translator: run.translator, judge: run.judge, glossaryVersion: run.glossaryVersion, sameProvider: run.sameProvider, fake, calls: run.calls, costUsd: run.costUsdMicro / 1e6, status: run.status,
      previousId: previous?.id ?? null, configurationChanged: previous !== undefined && (configuration(run) !== configuration(previous) || options.publicOnly === true && run.setHash !== previous.setHash), pairs: aggregate("pair"), categories: aggregate("category") };
  });
}
