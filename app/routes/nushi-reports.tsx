import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import type { Route } from "./+types/nushi-reports";
import { requireMember } from "~/lib/auth/session.server";
import { listNushiReports, nushiReportEvidence } from "~/lib/nushi-reports.server";
import { getViewer } from "~/lib/roles.server";
import { renderNushiReports } from "~/lib/nushi-html.server";
import { parsePage } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";

export async function loader({ request }: Route.LoaderArgs) {
  const { db, user } = await requireMember(request);
  const operator = (await getViewer(db, user)).scope.operator;
  const page = parsePage(request);
  const evidenceId = Number(new URL(request.url).searchParams.get("evidence"));
  const reportId = Number(new URL(request.url).searchParams.get("report"));
  const evidence = operator && Number.isSafeInteger(evidenceId) && evidenceId > 0 ? await nushiReportEvidence(db, evidenceId) : null;
  const view = { operator, page, evidence, reports: (await listNushiReports(db, { reporterId: operator ? undefined : user.id, page, id: Number.isSafeInteger(reportId) && reportId > 0 ? reportId : undefined })).map(report => ({ ...report, date: report.date.toISOString() })) };
  return { ...view, html: renderNushiReports(view), title: m.nushi_reports() };
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export function meta({ loaderData }: Route.MetaArgs) { return [{ title: loaderData?.title }]; }
export default function NushiReports({ loaderData }: Route.ComponentProps) {
  return <div dangerouslySetInnerHTML={{ __html: loaderData.html }} />;
}

export const middleware = [privateCacheMiddleware];
