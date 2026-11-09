import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import type { evaluationHistory } from "~/lib/eval/metrics.server";
import type { translationQualitySignals } from "~/lib/eval/signals.server";
import { m } from "~/paraglide/messages.js";

type History = Awaited<ReturnType<typeof evaluationHistory>>;
type Signals = Awaited<ReturnType<typeof translationQualitySignals>>;
const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const categories: Record<string, () => string> = {
  rights: m.quality_category_rights, negation: m.quality_category_negation, hedging: m.quality_category_hedging, attribution: m.quality_category_attribution,
  stance: m.quality_category_stance, terminology: m.quality_category_terminology, culture: m.quality_category_culture, symbols: m.quality_category_symbols, "short-reply": m.quality_category_short_reply,
};
function EvalTable({ cells, category = false, configurationChanged = false }: { cells: History[number]["pairs"]; category?: boolean; configurationChanged?: boolean }) {
  return <div className="max-w-full overflow-x-auto"><Table>
    <TableHeader><TableRow><TableHead>{category ? m.quality_eval_category() : m.quality_eval_pair()}</TableHead><TableHead>{m.quality_eval_preserved()}</TableHead><TableHead>{m.metrics_col_rate()}</TableHead><TableHead>{m.quality_eval_severe()}</TableHead><TableHead>{m.quality_eval_delta()}</TableHead></TableRow></TableHeader>
    <TableBody>{cells.map(c => <TableRow key={c.label}><TableCell>{category ? categories[c.label]?.() ?? c.label : c.label}</TableCell><TableCell>{c.preserved} / {c.total}</TableCell><TableCell>{percent(c.rate)}</TableCell><TableCell>{c.severe}</TableCell><TableCell>{c.delta === null ? "—" : `${c.delta >= 0 ? "+" : ""}${(c.delta * 100).toFixed(1)} / ${c.severeDelta! >= 0 ? "+" : ""}${c.severeDelta}`}{c.delta !== null && configurationChanged && <span className="mt-1 block max-w-64 whitespace-normal text-xs text-muted-foreground">{m.quality_eval_config_changed()}</span>}</TableCell></TableRow>)}</TableBody>
  </Table></div>;
}
export function QualityMetrics({ history, signals }: { history: History; signals: Signals }) {
  return <>
    <section aria-labelledby="quality-eval-title" className="space-y-3" data-testid="quality-evaluations">
      <h2 id="quality-eval-title" className="text-lg font-semibold">{m.quality_eval_title()}</h2>
      <p className="text-sm text-muted-foreground">{m.quality_eval_help()}</p>
      {!history.length && <p>{m.quality_eval_empty()}</p>}
      {history.map((run, index) => <details key={run.id} open={index === 0} className="space-y-3 rounded border p-3">
        <summary className="cursor-pointer">{m.quality_eval_run({ id: run.id.slice(0, 8), at: run.startedAt.slice(0, 16).replace("T", " ") + " UTC" })} · {run.status === "completed" ? m.quality_eval_completed() : run.status === "failed" ? m.quality_eval_failed() : m.quality_eval_running()}</summary>
        {run.fake && <p className="font-medium">{m.quality_eval_fake()}</p>}
        {run.sameProvider && <p className="font-medium">{m.quality_eval_same_provider()}</p>}
        <p className="break-words text-sm text-muted-foreground">{m.quality_eval_config({ translator: `${run.translator.provider} / ${run.translator.model} / ${run.translator.thinking} / ${run.translator.promptVersion}`, judge: `${run.judge.provider} / ${run.judge.model} / ${run.judge.thinking} / ${run.judge.promptVersion}`, version: run.setVersion, glossary: run.glossaryVersion ?? "—", calls: run.calls, cost: run.costUsd.toFixed(6) })}</p>
        <EvalTable cells={run.pairs} configurationChanged={run.configurationChanged} /><EvalTable cells={run.categories} category configurationChanged={run.configurationChanged} />
      </details>)}
    </section>
    <section aria-labelledby="quality-signals-title" className="space-y-3" data-testid="quality-signals">
      <h2 id="quality-signals-title" className="text-lg font-semibold">{m.quality_signals_title()}</h2>
      <p className="text-sm text-muted-foreground">{m.quality_signals_help({ since: signals.since.slice(0, 10) })}</p>
      {!signals.translations.length ? <p>{m.metrics_unobserved()}</p> : <div className="max-w-full overflow-x-auto"><Table>
        <TableHeader><TableRow><TableHead>{m.quality_signals_scope()}</TableHead><TableHead>{m.quality_eval_pair()}</TableHead><TableHead>{m.quality_generated()}</TableHead><TableHead>{m.quality_reports()}</TableHead><TableHead>{m.quality_corrected()}</TableHead><TableHead>{m.quality_median_days()}</TableHead></TableRow></TableHeader>
        <TableBody>{signals.translations.map(c => <TableRow key={`${c.scope}:${c.from}:${c.to}`}><TableCell>{c.scope === "post" ? m.quality_scope_post() : m.quality_scope_chat()}</TableCell><TableCell>{c.from} → {c.to}</TableCell><TableCell>{c.generated}</TableCell><TableCell>{c.reports} / {c.generated} ({percent(c.reportRate)})</TableCell><TableCell>{c.corrected} / {c.reports} ({percent(c.correctionRate)})</TableCell><TableCell>{c.medianDays === null ? "—" : c.medianDays.toFixed(1)}</TableCell></TableRow>)}</TableBody>
      </Table></div>}
    </section>
    <section aria-labelledby="quality-drafts-title" className="space-y-3" data-testid="quality-draft-edits">
      <h2 id="quality-drafts-title" className="text-lg font-semibold">{m.quality_drafts_title()}</h2>
      <p className="text-sm text-muted-foreground">{m.quality_drafts_help()}</p>
      {!signals.drafts.length ? <p>{m.metrics_unobserved()}</p> : <div className="max-w-full overflow-x-auto"><Table>
        <TableHeader><TableRow><TableHead>{m.quality_drafts_source()}</TableHead><TableHead>{m.quality_drafts_changed()}</TableHead><TableHead>{m.quality_drafts_chars()}</TableHead><TableHead>{m.quality_drafts_span()}</TableHead></TableRow></TableHeader>
        <TableBody>{signals.drafts.map(d => <TableRow key={d.source}><TableCell>{d.source.toUpperCase()}</TableCell><TableCell>{d.changed} / {d.published} ({percent(d.published ? d.changed / d.published : null)})</TableCell><TableCell>{d.beforeChars} → {d.afterChars}</TableCell><TableCell>{percent(d.spanRate)}</TableCell></TableRow>)}</TableBody>
      </Table></div>}
    </section>
  </>;
}
