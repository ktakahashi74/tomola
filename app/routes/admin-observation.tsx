import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import type { Route } from "./+types/admin-observation";
import { requireOperator } from "~/lib/auth/session.server";
import { currentEmbeddingModel, divergenceDetectionEnabled } from "~/lib/llm/config.server";
import { currentDivergenceSampleRate } from "~/lib/llm/divergence-sample.server";
import { LANG_LABELS, type Area } from "~/lib/languages";
import { CONFORMITY_DECLINES, MIN_DIVERSITY_ENTRIES } from "~/lib/observation";
import { getObservation } from "~/lib/observation.server";
import { m } from "~/paraglide/messages.js";

export function meta({}: Route.MetaArgs) {
  return [{ title: m.observation_title() }];
}

// Observation (operators only; other members get 404): the divergence counts, the diversity of posts by language area and month (with the warning for signs of conformity), and the trend
// of the ai_assistance record (only posts that carry a value; app/lib/observation.server.ts). The data export of the observation is /admin/export.
export async function loader({ request }: Route.LoaderArgs) {
  const { db } = await requireOperator(request);
  const observation = await getObservation(db, { model: currentEmbeddingModel() });
  return {
    accountsDeleted: observation.accountsDeleted,
    model: observation.model,
    // Multi-model divergence detection is disabled by default; show that state. Even with secondary and judge configured, a DIVERGENCE_SAMPLE_RATE
    // of 0 (the default) compares no translations; show this state too.
    divergenceEnabled: divergenceDetectionEnabled(),
    divergenceSampleRate: currentDivergenceSampleRate(),
    divergence: observation.divergence,
    diversity: observation.diversity,
    conformity: observation.conformity,
    aiAssistance: observation.aiAssistance.map((p) => ({ area: p.area, month: p.month, total: p.total, unstated: p.unstated, declaredShare: p.declaredShare })),
  };
}

const areaName = (a: Area) => (a === "other" ? m.area_other() : LANG_LABELS[a]);
const int = (n: number) => n.toLocaleString("en-US");
const percent = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const distance = (x: number) => x.toFixed(3);

function AreaHead({ area }: { area: Area }) {
  return area === "other" ? <span>{areaName(area)}</span> : <span lang={area}>{areaName(area)}</span>;
}

// Table of months (rows) × language areas (columns), including only months and areas with data.
function MatrixTable<T extends { area: Area; month: string }>({ points, cell }: { points: readonly T[]; cell: (p: T) => string }) {
  const months = [...new Set(points.map((p) => p.month))].sort();
  const areas = [...new Set(points.map((p) => p.area))];
  const at = new Map(points.map((p) => [`${p.area}|${p.month}`, p]));
  return (
    <div className="max-w-full overflow-x-auto">
      <Table className="text-start text-sm">
        <TableHeader>
          <TableRow className="border-b">
            <TableHead className="py-1 pe-6">{m.observation_month()}</TableHead>
            {areas.map((a) => (
              <TableHead key={a} className="py-1 pe-6 text-end">
                <AreaHead area={a} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {months.map((month) => (
            <TableRow key={month} className="border-b">
              <TableCell className="py-1 pe-6">{month}</TableCell>
              {areas.map((a) => {
                const p = at.get(`${a}|${month}`);
                return (
                  <TableCell key={a} className="py-1 pe-6 text-end">
                    {p ? cell(p) : "—"}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function AdminObservation({ loaderData }: Route.ComponentProps) {
  const { model, divergenceEnabled, divergenceSampleRate, divergence, diversity, conformity, aiAssistance } = loaderData;
  const compared = divergence.reduce((n, d) => n + d.measured, 0);
  const eligible = divergence.reduce((n, d) => n + d.eligible, 0);
  return (
    <main className="space-y-8">
      <h1 className="text-2xl font-bold">{m.observation_title()}</h1>
      <p>{m.observation_account_deletions({ count: loaderData.accountsDeleted })}</p>
      <p className="ui-meta">
        <a href="/admin/export" download className="underline">
          {m.observation_export()}
        </a>
        <span className="ms-2 text-muted-foreground">{m.observation_export_help()}</span>
      </p>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.observation_conformity_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.observation_conformity_help({ declines: CONFORMITY_DECLINES })}</p>
        {conformity.length === 0 ? (
          <p>{m.observation_conformity_none()}</p>
        ) : (
          <ul className="space-y-1">
            {conformity.map((w) => (
              <li key={w.area} role="alert" className="rounded bg-notice px-2 py-1 text-notice-foreground">
                {m.observation_conformity_warning({ area: areaName(w.area), from: w.months[0], values: w.values.map(distance).join(" → ") })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.observation_diversity_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.observation_diversity_help({ min: MIN_DIVERSITY_ENTRIES, model: model ?? "—" })}</p>
        {model === null ? <p>{m.observation_diversity_no_model()}</p> : diversity.length === 0 ? <p>{m.observation_empty()}</p> : <MatrixTable points={diversity} cell={(p) => `${distance(p.meanDistance)} (${int(p.entries)})`} />}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.observation_ai_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.observation_ai_help()}</p>
        {aiAssistance.length === 0 ? (
          <p>{m.observation_empty()}</p>
        ) : (
          <>
            <MatrixTable points={aiAssistance} cell={(p) => (p.declaredShare === null ? "—" : `${percent(p.declaredShare)} (${int(p.total)})`)} />
            <p className="ui-help text-muted-foreground">{m.observation_ai_unstated({ n: int(aiAssistance.reduce((sum, p) => sum + p.unstated, 0)) })}</p>
          </>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.observation_div_title()}</h2>
        {!divergenceEnabled ? (
          <p className="rounded border border-notice-border bg-notice-soft p-2 ui-help">{m.observation_div_off()}</p>
        ) : divergenceSampleRate <= 0 ? (
          <p role="status" className="rounded border border-notice-border bg-notice-soft p-2 ui-help">
            {m.observation_div_rate_zero()}
          </p>
        ) : (
          <p role="status" className="ui-help">
            {m.observation_div_rate({ rate: percent(divergenceSampleRate), compared: int(compared), eligible: int(eligible) })}
          </p>
        )}
        <p className="ui-help text-muted-foreground">{m.observation_div_help()}</p>
        <p className="ui-help text-muted-foreground">{m.observation_div_tone_guide()}</p>
        {divergence.length === 0 ? (
          <p>{m.observation_empty()}</p>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <Table className="text-start text-sm">
              <TableHeader>
                <TableRow className="border-b">
                  <TableHead className="py-1 pe-6">{m.observation_col_pair()}</TableHead>
                  <TableHead className="py-1 pe-6 text-end">{m.observation_col_measured()}</TableHead>
                  <TableHead className="py-1 pe-6 text-end">{m.observation_col_records()}</TableHead>
                  <TableHead className="py-1 pe-6 text-end">{m.observation_col_tone()}</TableHead>
                  <TableHead className="py-1 pe-6 text-end">{m.observation_col_low()}</TableHead>
                  <TableHead className="py-1 pe-6 text-end">{m.observation_col_medium()}</TableHead>
                  <TableHead className="py-1 pe-6 text-end">{m.observation_col_high()}</TableHead>
                  <TableHead className="py-1 pe-6 text-end">{m.observation_col_same_measured()}</TableHead>
                  <TableHead className="py-1 text-end">{m.observation_col_same_records()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {divergence.map((d) => (
                  <TableRow key={`${d.from}>${d.to}`} className="border-b">
                    <TableCell className="py-1 pe-6">
                      <span lang={d.from}>{LANG_LABELS[d.from]}</span> → <span lang={d.to}>{LANG_LABELS[d.to]}</span>
                    </TableCell>
                    <TableCell className="py-1 pe-6 text-end">{`${int(d.measured)} / ${int(d.eligible)}`}</TableCell>
                    <TableCell className="py-1 pe-6 text-end">{int(d.records)}</TableCell>
                    <TableCell className="py-1 pe-6 text-end">{int(d.tone)}</TableCell>
                    <TableCell className="py-1 pe-6 text-end">{int(d.severity.low)}</TableCell>
                    <TableCell className="py-1 pe-6 text-end">{int(d.severity.medium)}</TableCell>
                    <TableCell className="py-1 pe-6 text-end">{int(d.severity.high)}</TableCell>
                    <TableCell className="py-1 pe-6 text-end">{int(d.sameVendor.measured)}</TableCell>
                    <TableCell className="py-1 text-end">{int(d.sameVendor.records)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </main>
  );
}
