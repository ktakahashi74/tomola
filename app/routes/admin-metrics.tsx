import { ReadingMetrics } from "~/components/reading-metrics";
import { weeklyReadings } from "~/lib/reading-counts.server";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { QualityMetrics } from "~/components/quality-metrics";
import { evaluationHistory } from "~/lib/eval/metrics.server";
import { translationQualitySignals } from "~/lib/eval/signals.server";
import type { Route } from "./+types/admin-metrics";
import { aiLabel } from "~/components/ai-label";
import { AI_ASSISTANCE } from "~/lib/ai-assistance";
import { requireOperator } from "~/lib/auth/session.server";
import { LANG_LABELS, type Area } from "~/lib/languages";
import { getMetrics, observationWeeks } from "~/lib/metrics.server";
import { POSITIONS } from "~/lib/stances";
import { m } from "~/paraglide/messages.js";
import { Link } from "react-router";

export function meta({}: Route.MetaArgs) {
  return [{ title: m.metrics_title() }];
}

const day = (d: Date) => d.toISOString().slice(0, 10);

// Visible only to operators (OPERATOR_EMAILS); return 404 for other members. Serialize dates as strings for JSON transport.
// Stance numbers are only ever aggregated across questions here: nothing in this data has a question id, and no screen calls the reader of the stances by area.
export async function loader({ request }: Route.LoaderArgs) {
  const { db } = await requireOperator(request);
  const now = new Date();
  const metrics = await getMetrics(db, now);
  const [history, qualitySignals, reading] = await Promise.all([evaluationHistory(db), translationQualitySignals(db), weeklyReadings(db, now)]);
  const weeks = observationWeeks(now).map(day);
  // The distance points are grouped by pair of areas, one cell per week (the points come in order of the weeks).
  const pairs: Array<{ a: Area; b: Area; cells: Array<{ questions: number; people: number; sumDistance: number; mean: number | null }> }> = [];
  for (const p of metrics.stanceDistance) {
    let pair = pairs.find((x) => x.a === p.a && x.b === p.b);
    if (!pair) pairs.push((pair = { a: p.a, b: p.b, cells: [] }));
    pair.cells.push({ questions: p.questions, people: p.people, sumDistance: p.sumDistance, mean: p.mean });
  }
  return {
    history,
    questionReportsLabel: m.post_ask_reports_title(),
    qualitySignals,
    reading,
    weeks,
    crossAreaReplyRate: metrics.crossAreaReplyRate.map((w) => ({ ...w, weekStart: day(w.weekStart) })),
    insightful: metrics.crossAreaInsightful.map((w) => ({ ...w, weekStart: day(w.weekStart) })),
    update: metrics.crossAreaUpdate.map((w) => ({ ...w, weekStart: day(w.weekStart) })),
    active: metrics.activeMembers.map((w) => ({ ...w, weekStart: day(w.weekStart) })),
    retention: metrics.retention.map((c) => ({ ...c, cohortWeek: day(c.cohortWeek) })),
    firstParticipation: metrics.firstParticipation.map((c) => ({ ...c, cohortWeek: day(c.cohortWeek) })),
    direction: { from: day(metrics.directionMatrix.from), rows: metrics.directionMatrix.rows, insightful: metrics.directionMatrix.insightful, replies: metrics.directionMatrix.replies },
    distance: pairs,
    firstStances: metrics.firstStances,
    questionLangs: metrics.questionLangs.map((r) => ({ ...r, weekStart: r.weekStart === null ? null : day(r.weekStart) })),
    sustainedWriters: metrics.sustainedWriters,
    reports: metrics.reports,
    aiAssistance: metrics.aiAssistance,
    postsByVia: metrics.postsByVia,
  };
}

const areaName = (a: Area) => (a === "other" ? m.area_other() : LANG_LABELS[a]);
// Use locale-independent formatting to avoid server/browser display differences.
const int = (n: number) => n.toLocaleString("en-US");
const percent = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;

function duration(seconds: number): string {
  if (seconds < 3600) return m.metrics_minutes({ n: Math.max(1, Math.round(seconds / 60)) });
  if (seconds < 48 * 3600) return m.metrics_hours({ n: Math.round(seconds / 360) / 10 });
  return m.metrics_days({ n: Math.round(seconds / 8640) / 10 });
}

function AreaCell({ area }: { area: Area }) {
  return area === "other" ? <span>{areaName(area)}</span> : <span lang={area}>{areaName(area)}</span>;
}

type Cell = { observed: true; numerator: number; denominator: number; people: number; rate: number } | { observed: false };

// Numerator, denominator, rate and people of a rate; "not observed" when the denominator is 0.
function RateCells({ cell }: { cell: Cell }) {
  if (!cell.observed)
    return (
      <TableCell colSpan={4} className="py-1 text-muted-foreground">
        {m.metrics_unobserved()}
      </TableCell>
    );
  return (
    <>
      <TableCell className="py-1 pe-6 text-end">{int(cell.numerator)}</TableCell>
      <TableCell className="py-1 pe-6 text-end">{int(cell.denominator)}</TableCell>
      <TableCell className="py-1 pe-6 text-end">{percent(cell.rate)}</TableCell>
      <TableCell className="py-1 text-end">{int(cell.people)}</TableCell>
    </>
  );
}

function RateHeads() {
  return (
    <>
      <TableHead className="py-1 pe-6 text-end">{m.metrics_col_numerator()}</TableHead>
      <TableHead className="py-1 pe-6 text-end">{m.metrics_col_denominator()}</TableHead>
      <TableHead className="py-1 pe-6 text-end">{m.metrics_col_rate()}</TableHead>
      <TableHead className="py-1 text-end">{m.metrics_col_people()}</TableHead>
    </>
  );
}

// A matrix of the direction of reactions: rows are the authors' areas, columns the areas of the members who reacted. Each cell is "numerator / denominator (people)".
type DirectionCell = { authorArea: Area; reactorArea: Area; numerator: number; denominator: number; people: number };
function DirectionTable({ cells, rows }: { cells: DirectionCell[]; rows: Array<{ authorArea: Area; entries: number; authors: number }> }) {
  const columns = [...new Set(cells.map((c) => c.reactorArea))];
  return (
    <div className="max-w-full overflow-x-auto">
      <Table className="text-start text-sm">
        <TableHeader>
          <TableRow className="border-b">
            <TableHead className="py-1 pe-6">{m.metrics_dir_corner()}</TableHead>
            {columns.map((a) => (
              <TableHead key={a} className="py-1 pe-6 text-end">
                <AreaCell area={a} />
              </TableHead>
            ))}
            <TableHead className="py-1 text-end">{m.metrics_dir_rows()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const own = cells.filter((c) => c.authorArea === row.authorArea);
            const denominator = own[0]?.denominator ?? 0;
            return (
              <TableRow key={row.authorArea} className="border-b">
                <TableCell className="py-1 pe-6">
                  <AreaCell area={row.authorArea} />
                </TableCell>
                {denominator === 0 ? (
                  <TableCell colSpan={columns.length} className="py-1 pe-6 text-muted-foreground">
                    {m.metrics_unobserved()}
                  </TableCell>
                ) : (
                  columns.map((a) => {
                    const cell = own.find((c) => c.reactorArea === a);
                    return (
                      <TableCell key={a} className="py-1 pe-6 text-end">
                        {m.metrics_cell({ numerator: int(cell?.numerator ?? 0), denominator: int(denominator), people: int(cell?.people ?? 0) })}
                      </TableCell>
                    );
                  })
                )}
                <TableCell className="py-1 text-end">{`${int(row.entries)} / ${int(row.authors)}`}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function AdminMetrics({ loaderData }: Route.ComponentProps) {
  const { weeks, crossAreaReplyRate, insightful, update, active, retention, firstParticipation, direction, distance, firstStances, questionLangs, sustainedWriters, reports, aiAssistance, postsByVia } = loaderData;
  const langs = [...new Set(questionLangs.map((r) => r.lang))];
  const langRows = [...weeks, null].map((week) => ({ week, cells: questionLangs.filter((r) => r.weekStart === week) }));
  return (
    <main className="space-y-8">
      <h1 className="text-2xl font-bold">{m.metrics_title()}</h1>
      <p className="ui-help text-muted-foreground">{m.metrics_note()}</p>
      <p><Link className="underline" to="/admin/ai-question-reports">{loaderData.questionReportsLabel}</Link></p>

      <ReadingMetrics readings={loaderData.reading} />
      <QualityMetrics history={loaderData.history} signals={loaderData.qualitySignals} />

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_cross_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_cross_help()}</p>
        <div className="max-w-full overflow-x-auto">
          <Table className="text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-6">{m.metrics_col_week()}</TableHead>
                <TableHead className="py-1 pe-6 text-end">{m.metrics_col_topics()}</TableHead>
                <TableHead className="py-1 pe-6 text-end">{m.metrics_col_cross()}</TableHead>
                <TableHead className="py-1 pe-6 text-end">{m.metrics_col_rate()}</TableHead>
                <TableHead className="py-1 text-end">{m.metrics_col_people()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crossAreaReplyRate.map((w) => (
                <TableRow key={w.weekStart} className="border-b">
                  <TableCell className="py-1 pe-6">{w.weekStart}</TableCell>
                  {w.rate === null ? (
                    <TableCell colSpan={4} className="py-1 text-muted-foreground">
                      {m.metrics_unobserved()}
                    </TableCell>
                  ) : (
                    <>
                      <TableCell className="py-1 pe-6 text-end">{int(w.topics)}</TableCell>
                      <TableCell className="py-1 pe-6 text-end">{int(w.crossArea)}</TableCell>
                      <TableCell className="py-1 pe-6 text-end">{percent(w.rate)}</TableCell>
                      <TableCell className="py-1 text-end">{int(w.people)}</TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_insight_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_insight_help()}</p>
        <div className="max-w-full overflow-x-auto">
          <Table className="text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-6">{m.metrics_col_week()}</TableHead>
                <RateHeads />
              </TableRow>
            </TableHeader>
            <TableBody>
              {insightful.map((w) => (
                <TableRow key={w.weekStart} className="border-b">
                  <TableCell className="py-1 pe-6">{w.weekStart}</TableCell>
                  <RateCells cell={w} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_update_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_update_help()}</p>
        <div className="max-w-full overflow-x-auto">
          <Table className="text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-6">{m.metrics_col_week()}</TableHead>
                <TableHead className="py-1 pe-6 text-end">{m.metrics_col_changes()}</TableHead>
                <RateHeads />
              </TableRow>
            </TableHeader>
            <TableBody>
              {update.map((w) => (
                <TableRow key={w.weekStart} className="border-b">
                  <TableCell className="py-1 pe-6">{w.weekStart}</TableCell>
                  <TableCell className="py-1 pe-6 text-end">{int(w.changes)}</TableCell>
                  <RateCells cell={w} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_active_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_active_help()}</p>
        <div className="max-w-full overflow-x-auto">
          <Table className="text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-6">{m.metrics_col_week()}</TableHead>
                <TableHead className="py-1 text-end">{m.metrics_col_active()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {active.map((w) => (
                <TableRow key={w.weekStart} className="border-b">
                  <TableCell className="py-1 pe-6">{w.weekStart}</TableCell>
                  <TableCell className="py-1 text-end">{int(w.members)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_retention_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_retention_help()}</p>
        <div className="max-w-full overflow-x-auto">
          <Table className="text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-6">{m.metrics_col_cohort()}</TableHead>
                <RateHeads />
              </TableRow>
            </TableHeader>
            <TableBody>
              {retention.map((c) => (
                <TableRow key={c.cohortWeek} className="border-b">
                  <TableCell className="py-1 pe-6">{c.cohortWeek}</TableCell>
                  <RateCells cell={c} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_first_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_first_help()}</p>
        <div className="max-w-full overflow-x-auto">
          <Table className="text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-6" rowSpan={2}>
                  {m.metrics_col_cohort()}
                </TableHead>
                <TableHead className="py-1 pe-6 text-center" colSpan={4}>
                  {m.metrics_col_first_stance()}
                </TableHead>
                <TableHead className="py-1 text-center" colSpan={4}>
                  {m.metrics_col_first_post()}
                </TableHead>
              </TableRow>
              <TableRow className="border-b">
                <RateHeads />
                <RateHeads />
              </TableRow>
            </TableHeader>
            <TableBody>
              {firstParticipation.map((c) => (
                <TableRow key={c.cohortWeek} className="border-b">
                  <TableCell className="py-1 pe-6">{c.cohortWeek}</TableCell>
                  <RateCells cell={c.stance} />
                  <RateCells cell={c.post} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2" aria-labelledby="metrics-operator-only">
        <h2 id="metrics-operator-only" className="text-lg font-semibold">
          {m.metrics_dir_title()}
        </h2>
        <p role="note" className="rounded border border-notice-border bg-notice-soft p-2 ui-help">
          {m.metrics_small_numbers()}
        </p>
        <p className="ui-help text-muted-foreground">{m.metrics_dir_help({ from: direction.from })}</p>
        {direction.rows.length === 0 ? (
          <p>{m.metrics_unobserved()}</p>
        ) : (
          <>
            <h3 className="font-semibold">{m.metrics_dir_insightful()}</h3>
            <DirectionTable cells={direction.insightful} rows={direction.rows} />
            <h3 className="font-semibold">{m.metrics_dir_replies()}</h3>
            <DirectionTable cells={direction.replies} rows={direction.rows} />
          </>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_distance_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_distance_help()}</p>
        {distance.length === 0 ? (
          <p>{m.metrics_unobserved()}</p>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <Table className="text-start text-sm">
              <TableHeader>
                <TableRow className="border-b">
                  <TableHead className="py-1 pe-6">{m.metrics_col_pair()}</TableHead>
                  {weeks.map((w) => (
                    <TableHead key={w} className="py-1 pe-6 text-end">
                      {w}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {distance.map((pair) => (
                  <TableRow key={`${pair.a}|${pair.b}`} className="border-b">
                    <TableCell className="py-1 pe-6">
                      <AreaCell area={pair.a} /> – <AreaCell area={pair.b} />
                    </TableCell>
                    {pair.cells.map((c, i) => (
                      <TableCell key={weeks[i]} className="py-1 pe-6 text-end">
                        {c.mean === null
                          ? m.metrics_unobserved()
                          : m.metrics_distance_cell({ mean: c.mean.toFixed(2), sum: c.sumDistance.toFixed(2), questions: int(c.questions), people: int(c.people) })}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_first_stances_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_first_stances_help()}</p>
        {firstStances.length === 0 ? (
          <p>{m.metrics_unobserved()}</p>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <Table className="text-start text-sm">
              <TableHeader>
                <TableRow className="border-b">
                  <TableHead className="py-1 pe-6">{m.metrics_col_area()}</TableHead>
                  {POSITIONS.map((p) => (
                    <TableHead key={p} className="py-1 pe-6 text-end">
                      {p === "agree" ? m.stance_agree() : p === "disagree" ? m.stance_disagree() : m.stance_neither()}
                    </TableHead>
                  ))}
                  <TableHead className="py-1 pe-6 text-end">{m.metrics_col_questions()}</TableHead>
                  <TableHead className="py-1 text-end">{m.metrics_col_people()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {firstStances.map((row) => (
                  <TableRow key={row.area} className="border-b">
                    <TableCell className="py-1 pe-6">
                      <AreaCell area={row.area} />
                    </TableCell>
                    {POSITIONS.map((p) => (
                      <TableCell key={p} className="py-1 pe-6 text-end">
                        {m.metrics_cell({ numerator: int(row.counts[p].numerator), denominator: int(row.counts[p].denominator), people: int(row.counts[p].people) })}
                      </TableCell>
                    ))}
                    <TableCell className="py-1 pe-6 text-end">{int(row.questions)}</TableCell>
                    <TableCell className="py-1 text-end">{int(row.people)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_langs_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_langs_help()}</p>
        {langs.length === 0 ? (
          <p>{m.metrics_unobserved()}</p>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <Table className="text-start text-sm">
              <TableHeader>
                <TableRow className="border-b">
                  <TableHead className="py-1 pe-6">{m.metrics_col_week()}</TableHead>
                  {langs.map((l) => (
                    <TableHead key={l} className="py-1 pe-6 text-end">
                      <span lang={l}>{LANG_LABELS[l]}</span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {langRows.map(({ week, cells }) => (
                  <TableRow key={week ?? "total"} className="border-b">
                    <TableCell className="py-1 pe-6">{week ?? m.metrics_col_whole_period()}</TableCell>
                    {cells.length === 0 ? (
                      <TableCell colSpan={langs.length} className="py-1 text-muted-foreground">
                        {m.metrics_unobserved()}
                      </TableCell>
                    ) : (
                      langs.map((l) => {
                        const cell = cells.find((c) => c.lang === l);
                        return (
                          <TableCell key={l} className="py-1 pe-6 text-end">
                            {cell ? m.metrics_cell({ numerator: int(cell.numerator), denominator: int(cell.denominator), people: int(cell.people) }) : "—"}
                          </TableCell>
                        );
                      })
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_writers_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_writers_help()}</p>
        <div className="max-w-full overflow-x-auto">
          <Table className="text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-6">{m.metrics_col_area()}</TableHead>
                <TableHead className="py-1 text-end">{m.metrics_col_writers()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sustainedWriters.map((w) => (
                <TableRow key={w.area} className="border-b">
                  <TableCell className="py-1 pe-6">
                    <AreaCell area={w.area} />
                  </TableCell>
                  <TableCell className="py-1 text-end">{int(w.count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_reports_title()}</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">{m.metrics_reports_total()}</dt>
          <dd>{int(reports.total)}</dd>
          <dt className="text-muted-foreground">{m.metrics_reports_open()}</dt>
          <dd>{int(reports.open)}</dd>
          <dt className="text-muted-foreground">{m.metrics_reports_resolved()}</dt>
          <dd>{int(reports.resolved)}</dd>
          <dt className="text-muted-foreground">{m.metrics_reports_auto()}</dt>
          <dd>{int(reports.autoResolved)}</dd>
          <dt className="text-muted-foreground">{m.metrics_reports_median()}</dt>
          <dd>{reports.medianResolutionSeconds === null ? "—" : duration(reports.medianResolutionSeconds)}</dd>
        </dl>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_ai_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_ai_help()}</p>
        <div className="max-w-full overflow-x-auto">
          <Table className="text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-6">{m.metrics_col_area()}</TableHead>
                {AI_ASSISTANCE.map((level) => (
                  <TableHead key={level} className="py-1 pe-6 text-end">
                    {aiLabel(level)}
                  </TableHead>
                ))}
                <TableHead className="py-1 pe-6 text-end">{m.metrics_col_total()}</TableHead>
                <TableHead className="py-1 text-end">{m.metrics_ai_col_unstated()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aiAssistance.map((row) => (
                <TableRow key={row.area} className="border-b">
                  <TableCell className="py-1 pe-6">
                    <AreaCell area={row.area} />
                  </TableCell>
                  {AI_ASSISTANCE.map((level) => (
                    <TableCell key={level} className="py-1 pe-6 text-end">
                      {int(row.counts[level])}
                      {row.total > 0 && <span className="ms-1 ui-meta text-muted-foreground">({percent(row.counts[level] / row.total)})</span>}
                    </TableCell>
                  ))}
                  <TableCell className="py-1 pe-6 text-end">{int(row.total)}</TableCell>
                  <TableCell className="py-1 text-end">{int(row.unstated)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.metrics_via_title()}</h2>
        <p className="ui-help text-muted-foreground">{m.metrics_via_help()}</p>
        {postsByVia.length === 0 ? (
          <p>{m.metrics_unobserved()}</p>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <Table className="text-start text-sm">
              <TableHeader>
                <TableRow className="border-b">
                  <TableHead className="py-1 pe-6">{m.metrics_via_col()}</TableHead>
                  <RateHeads />
                </TableRow>
              </TableHeader>
              <TableBody>
                {postsByVia.map((row) => (
                  <TableRow key={row.via} className="border-b">
                    <TableCell className="py-1 pe-6">{row.via === "web" ? m.metrics_via_web() : m.metrics_via_api()}</TableCell>
                    <RateCells cell={{ observed: true, numerator: row.numerator, denominator: row.denominator, people: row.people, rate: row.numerator / row.denominator }} />
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
