import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/post-ai-materials";
import { getReader, requireWriter } from "~/lib/auth/session.server";
import { getViewer, inScope } from "~/lib/roles.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { parseId } from "~/lib/params.server";
import { POST_AI_HISTORY_PAGE_SIZE, materialTopic, moderatePostAiMaterial, postAiMaterialHistory, readPostAiMaterial, writePostAiMaterial } from "~/lib/post-ai-materials.server";
import { instructionWarnings, POST_AI_MATERIAL_CHARS } from "~/lib/post-ai-materials";
import { createReport } from "~/lib/moderation.server";
import { postAiMaterials, postAiMaterialVersions } from "~/lib/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { m } from "~/paraglide/messages.js";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { LocalTime } from "~/components/local-time";
import { ReportReasonSelect } from "~/components/report-reason-select";

export const middleware = [privateCacheMiddleware];
export async function loader({ request, params }: Route.LoaderArgs) {
  if (params.view && !["edit", "history"].includes(params.view)) throw data("Not found", { status: 404 });
  const { db, user } = await getReader(request);
  const topicId = parseId(params.id), topic = await materialTopic(db, topicId);
  if (!topic) throw data("Not found", { status: 404 });
  const viewer = user ? await getViewer(db, user) : null;
  const owner = user?.id === topic.authorId;
  const moderator = !!viewer && !owner && inScope(viewer.scope, topic.fallbackLang);
  const material = await readPostAiMaterial(db, topicId, viewer);
  if (params.view === "edit" ? !owner : !material) throw data("Not found", { status: 404 });
  const before = new URL(request.url).searchParams.get("before");
  const history = params.view === "history" && material ? await postAiMaterialHistory(db, topicId, before === null ? undefined : parseId(before)) : { rows: [], nextBefore: null };
  const [retained] = owner && params.view === "edit" && !material ? await db.select({ version: postAiMaterials.version }).from(postAiMaterials).where(eq(postAiMaterials.topicId, topicId)) : [];
  const warnings = viewer?.scope.operator ? await db.select({ version: postAiMaterialVersions.version, rules: postAiMaterialVersions.instructionWarnings })
    .from(postAiMaterialVersions).where(and(eq(postAiMaterialVersions.topicId, topicId), params.view === "history" ? inArray(postAiMaterialVersions.version, history.rows.map(row => row.version)) : undefined)).orderBy(desc(postAiMaterialVersions.version)).limit(POST_AI_HISTORY_PAGE_SIZE) : null;
  return { topicId, owner, moderator, member: !!user, view: params.view, version: material?.version ?? retained?.version ?? 0,
    instructionNotice: owner && !!material && instructionWarnings(material.text).length > 0,
    body: params.view === "edit" ? material?.body ?? "" : "", material: material ? { html: material.html, author: material.author, lang: material.lang, hidden: material.hidden, materialHidden: material.materialHidden, updatedAt: material.updatedAt } : null,
    nextBefore: history.nextBefore, history: history.rows.map(({ version, html, event, createdAt }) => ({ version, html, event, createdAt })), warnings,
    saved: new URL(request.url).searchParams.has("saved") };
}
export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") throw data("Method not allowed", { status: 405 });
  assertSameOrigin(request);
  const { db, user } = await requireWriter(request);
  await enforceMemberLimit(db, "edit", user.id);
  const topicId = parseId(params.id), form = await request.formData(), intent = String(form.get("intent") ?? "save");
  const version = Number(form.get("version"));
  if (!Number.isSafeInteger(version) || version < 0) throw data("Invalid", { status: 400 });
  if (intent === "report") {
    await enforceMemberLimit(db, "report", user.id);
    if (!await readPostAiMaterial(db, topicId)) throw data("Not found", { status: 404 });
    const result = await createReport(db, user.id, { entryId: topicId, reason: form.get("reason"), note: `AI supplement: /t/${topicId}/ai-materials (version ${version}). ${String(form.get("note") ?? "").slice(0, 800)}` });
    return data({ message: result.ok || result.error === "duplicate" ? m.flag_already_reported() : m.ai_material_error(), body: undefined }, { status: result.ok || result.error === "duplicate" ? 200 : 400 });
  }
  if (intent === "hide" || intent === "unhide") {
    const result = await moderatePostAiMaterial(db, await getViewer(db, user), topicId, intent === "hide", String(form.get("note") ?? ""), version);
    if (!result.ok) throw data(result.error, { status: result.error === "forbidden" ? 403 : result.error === "conflict" ? 409 : 400 });
    throw redirect(`/t/${topicId}/ai-materials`);
  }
  if (!["save", "delete"].includes(intent)) throw data("Invalid", { status: 400 });
  const body = String(form.get("aiMaterial") ?? "");
  const result = await writePostAiMaterial(db, user.id, topicId, { body, version, remove: intent === "delete" });
  if (!result.ok) {
    if (result.error === "forbidden" || result.error === "not_found") throw data(result.error, { status: result.error === "forbidden" ? 403 : 404 });
    return data({ message: result.error === "conflict" ? m.ai_material_conflict() : m.ai_material_error(), body }, { status: result.error === "conflict" ? 409 : 400 });
  }
  if (intent === "delete") throw redirect(`/t/${topicId}`);
  return data({ message: result.warnings.length ? m.ai_material_instruction_warning() : m.ai_material_saved(), body: undefined });
}
export function meta() { return [{ title: m.ai_material_title() }, { name: "robots", content: "noindex" }]; }
export default function PostAiMaterials({ loaderData: view, actionData }: Route.ComponentProps) {
  const base = `/t/${view.topicId}/ai-materials`;
  return <main className="reading-column space-y-5">
    <Link className="underline" to={`/t/${view.topicId}`}>{m.post_ask_back()}</Link>
    <h1 className="text-2xl font-bold">{m.ai_material_title()}</h1>
    <p className="ui-help">{m.ai_material_notice()}</p>
    {actionData?.message && <p role="status">{actionData.message}</p>}
    {!actionData?.message && (view.saved || view.instructionNotice) && <p role="status">{view.instructionNotice ? m.ai_material_instruction_warning() : m.ai_material_saved()}</p>}
    {view.view === "edit" ? <Form method="post" className="space-y-3">
      <input type="hidden" name="version" value={view.version} />
      <label className="block" htmlFor="ai-material">{m.ai_material_title()}</label>
      <Textarea id="ai-material" name="aiMaterial" rows={16} maxLength={POST_AI_MATERIAL_CHARS} defaultValue={actionData?.body ?? view.body} required />
      <p className="ui-help">{m.ai_material_input_help({ count: POST_AI_MATERIAL_CHARS })}</p>
      <Button type="submit" name="intent" value="save">{m.save_changes()}</Button>
      {view.version > 0 && <Button type="submit" name="intent" value="delete" formNoValidate variant="outline">{m.ai_material_delete()}</Button>}
    </Form> : <>
      {view.material && <>
        <p className="ui-meta">{view.material.author} · <LocalTime iso={view.material.updatedAt.toISOString()} style="date" /></p>
        {view.material.hidden && <p role="status">{m.ai_material_hidden()}</p>}
        {view.view !== "history" && <div id="material" lang={view.material.lang} dir="auto" className="longread longread-compact max-w-none break-words" dangerouslySetInnerHTML={{ __html: view.material.html }} />}
      </>}
      <div className="flex gap-4 ui-meta"><Link className="underline" to={`${base}/history`}>{m.history_title()}</Link>{view.owner && <Link className="underline" to={`${base}/edit`}>{m.edit()}</Link>}</div>
      {view.history.map(row => <article key={row.version} className="space-y-2 border-t pt-3"><h2>{row.version} · <LocalTime iso={row.createdAt.toISOString()} style="date" /></h2><p>{row.event === "edit" ? m.edit() : row.event === "hide" ? m.ai_material_hide() : m.ai_material_unhide()}</p><div dir="auto" lang={view.material?.lang} className="longread longread-compact break-words" dangerouslySetInnerHTML={{ __html: row.html }} /></article>)}
      {view.nextBefore && <Link className="underline" to={`${base}/history?before=${view.nextBefore}`}>{m.page_next()}</Link>}
      {view.member && !view.owner && !view.material?.hidden && <details><summary>{m.flag_short()}</summary><Form method="post" className="space-y-2">
        <input type="hidden" name="intent" value="report" /><input type="hidden" name="version" value={view.version} />
        <ReportReasonSelect label={m.flag_reason()} defaultValue="spam" />
        <label className="block">{m.flag_note()}<Textarea name="note" maxLength={800} /></label><p className="ui-help">{m.flag_privacy()}</p><Button type="submit">{m.flag_submit()}</Button>
      </Form></details>}
      {view.moderator && <Form method="post" className="space-y-2 border-t pt-3"><input type="hidden" name="version" value={view.version} />
        <label className="block">{m.flag_note()}<Textarea name="note" required maxLength={1000} /></label>
        <Button type="submit" name="intent" value={view.material?.materialHidden ? "unhide" : "hide"}>{view.material?.materialHidden ? m.ai_material_unhide() : m.ai_material_hide()}</Button>
      </Form>}
    </>}
    {view.warnings && <details><summary>{m.ai_material_review_log()}</summary><pre className="whitespace-pre-wrap">{JSON.stringify(view.warnings, null, 2)}</pre></details>}
  </main>;
}
