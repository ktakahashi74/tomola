import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Link } from "react-router";
import type { Route } from "./+types/admin-usage";
import { listFlaggedTranslations } from "~/lib/flagged-translations.server";
import { requireOperator } from "~/lib/auth/session.server";
import { formatUsdMicro } from "~/lib/llm/format";
import type { BudgetState } from "~/lib/llm/types";
import { countFailedJobs } from "~/lib/jobs/queue.server";
import { getBudgetStatus, getChatBudgetStatus, getMonthlyBreakdown, countBudgetReservationWaits } from "~/lib/llm/usage.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { m } from "~/paraglide/messages.js";

// Visible only to operators (OPERATOR_EMAILS); other members get 404.
export async function loader({ request }: Route.LoaderArgs) {
  const { db } = await requireOperator(request);
  const now = new Date();
  const [status, rows, failedJobs, flagged, reservationWaits] = await Promise.all([getBudgetStatus(db, now), getMonthlyBreakdown(db, now), countFailedJobs(db), listFlaggedTranslations(db), countBudgetReservationWaits(db)]);
  return {
    chat: villageChatEnabled() ? await getChatBudgetStatus(db, now) : null,
    month: status.monthStart.toISOString().slice(0, 7),
    state: status.state,
    reservationWaits,
    usedMicro: status.usedMicro,
    budgetMicro: status.budgetMicro,
    percent: status.percent,
    resetsAt: status.monthEnd.toISOString(),
    rows,
    // Number of failed jobs by kind.
    failedJobs,
    // Translations that carry a check mark (structure, link, untranslated, near copy), newest first.
    flagged: flagged.map((f) => ({ ...f, updatedAt: f.updatedAt.toISOString() })),
  };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.usage_title() }];
}

function stateLabel(state: BudgetState): string {
  return state === "normal" ? m.usage_state_normal() : state === "degraded" ? m.usage_state_degraded() : m.usage_state_stopped();
}

function stateHelp(state: BudgetState): string {
  return state === "normal" ? m.usage_state_normal_help() : state === "degraded" ? m.usage_state_degraded_help() : m.usage_state_stopped_help();
}

function purposeLabel(purpose: string): string {
  if (purpose === "translate") return m.usage_purpose_translate();
  if (purpose === "retry") return m.usage_purpose_retry();
  if (purpose === "judge") return m.usage_purpose_judge();
  if (purpose === "embed") return m.usage_purpose_embed();
  if (purpose === "chat") return m.usage_purpose_chat();
  return purpose;
}

// Use locale-independent formatting to avoid server/browser display differences.
const int = (n: number) => n.toLocaleString("en-US");

export default function AdminUsage({ loaderData }: Route.ComponentProps) {
  const { month, state, usedMicro, budgetMicro, percent, resetsAt, rows, failedJobs, flagged } = loaderData;
  const tone = state === "normal" ? "text-success" : state === "degraded" ? "text-notice-muted" : "text-destructive";
  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-bold">{m.usage_title()}</h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
        <dt className="text-muted-foreground">{m.usage_month()}</dt>
        <dd>{month}</dd>
        <dt className="text-muted-foreground">{m.usage_used()}</dt>
        <dd>{formatUsdMicro(usedMicro)}</dd>
        <dt className="text-muted-foreground">{m.usage_budget()}</dt>
        <dd>{formatUsdMicro(budgetMicro, 2)}</dd>
        <dt className="text-muted-foreground">{m.usage_percent()}</dt>
        <dd>{percent.toFixed(1)}%</dd>
        <dt className="text-muted-foreground">{m.usage_state()}</dt>
        <dd>
          <span className={`font-semibold ${tone}`}>{stateLabel(state)}</span>
          <span className="ms-2 ui-help text-muted-foreground">{stateHelp(state)}</span>
        </dd>
        <dt className="text-muted-foreground">{m.usage_resets()}</dt>
        <dd>
          <time dateTime={resetsAt}>{resetsAt.slice(0, 10)}</time>
        </dd>
      </dl>
      {loaderData.reservationWaits > 0 && <p>{m.usage_waiting_estimate({ count: loaderData.reservationWaits })}</p>}
      {loaderData.chat && <p>{m.usage_chat_budget()}: {formatUsdMicro(loaderData.chat.usedMicro)} / {formatUsdMicro(loaderData.chat.budgetMicro, 2)} · {stateLabel(loaderData.chat.state)}</p>}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.usage_breakdown()}</h2>
        {rows.length === 0 ? (
          <p>{m.usage_empty()}</p>
        ) : (
          <Table className="w-full text-start text-sm">
            <TableHeader>
              <TableRow className="border-b">
                <TableHead className="py-1 pe-3">{m.usage_col_engine()}</TableHead>
                <TableHead className="py-1 pe-3">{m.usage_col_model()}</TableHead>
                <TableHead className="py-1 pe-3">{m.usage_col_purpose()}</TableHead>
                <TableHead className="py-1 pe-3 text-end">{m.usage_col_calls()}</TableHead>
                <TableHead className="py-1 pe-3 text-end">{m.usage_col_input()}</TableHead>
                <TableHead className="py-1 pe-3 text-end">{m.usage_col_output()}</TableHead>
                <TableHead className="py-1 text-end">{m.usage_col_cost()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.engine}/${r.model}/${r.purpose}`} className="border-b">
                  <TableCell className="py-1 pe-3">{r.engine}</TableCell>
                  <TableCell className="py-1 pe-3">{r.model}</TableCell>
                  <TableCell className="py-1 pe-3">{purposeLabel(r.purpose)}</TableCell>
                  <TableCell className="py-1 pe-3 text-end">{int(r.calls)}</TableCell>
                  <TableCell className="py-1 pe-3 text-end">{int(r.inputTokens)}</TableCell>
                  <TableCell className="py-1 pe-3 text-end">{int(r.outputTokens)}</TableCell>
                  <TableCell className="py-1 text-end">{formatUsdMicro(r.costMicro)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.usage_failed_jobs()}</h2>
        {failedJobs.length === 0 ? (
          <p>{m.usage_failed_none()}</p>
        ) : (
          <>
            <Table className="text-start text-sm">
              <TableHeader>
                <TableRow className="border-b">
                  <TableHead className="py-1 pe-6">{m.usage_col_job()}</TableHead>
                  <TableHead className="py-1 text-end">{m.usage_col_count()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failedJobs.map((j) => (
                  <TableRow key={j.kind} className="border-b">
                    <TableCell className="py-1 pe-6 font-mono">{j.kind}</TableCell>
                    <TableCell className="py-1 text-end text-destructive">{int(j.count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="ui-help text-muted-foreground">{m.usage_failed_hint()}</p>
          </>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{m.usage_flagged_title()}</h2>
        {flagged.length === 0 ? (
          <p>{m.usage_flagged_none()}</p>
        ) : (
          <>
            <ul className="space-y-1 ui-meta">
              {flagged.map((f) => (
                <li key={`${f.entryId}:${f.field}:${f.lang}`}>
                  <Link to={`/t/${f.threadId}?lang=${f.lang}#${f.kind === "topic" ? "p" : "c"}-${f.entryId}`} className="underline">
                    #{f.entryId} · {f.lang} · {f.field}
                  </Link>{" "}
                  <span className="font-mono text-notice-muted">{f.flags.join(", ")}</span>
                  {f.model && <span className="text-muted-foreground"> · {f.model}</span>}
                </li>
              ))}
            </ul>
            <p className="ui-help text-muted-foreground">{m.usage_flagged_hint()}</p>
          </>
        )}
      </section>
    </main>
  );
}
