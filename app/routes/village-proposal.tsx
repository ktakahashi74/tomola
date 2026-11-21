import { data, Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/village-proposal";
import { Button } from "~/components/ui/button";
import { VillageIcon } from "~/components/village-icon";
import { requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { applyVillageProposal, discardVillageProposalReview, readVillageProposalReview } from "~/lib/mcp/village-proposals.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { m } from "~/paraglide/messages.js";

const HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "strict-origin", "X-Robots-Tag": "noindex" };
const notFound = () => data("Not found", { status: 404, headers: HEADERS });
export function headers() { return HEADERS; }
export function meta() { return [{ title: m.village_proposal_title() }]; }

export async function loader({ request, params }: Route.LoaderArgs) {
  if (!villagesEnabled()) throw notFound();
  const { db, user } = await requireWriter(request);
  const review = await readVillageProposalReview(db, user.id, params.id);
  if (!review.ok) {
    if (review.error === "not_found") throw notFound();
    return data({ review: null, target: { version: review.version, village: review.village } }, { status: 409, headers: HEADERS });
  }
  return data({ review, target: { version: review.version, village: review.village } }, { headers: HEADERS });
}

export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (!villagesEnabled()) throw notFound();
  if (request.method !== "POST") throw new Response(null, { status: 405, headers: { ...HEADERS, Allow: "POST" } });
  const { db, user } = await requireWriter(request);
  const form = await request.formData();
  const version = form.get("version");
  const intent = form.get("intent");
  if (form.getAll("version").length !== 1 || typeof version !== "string" || form.getAll("intent").length !== 1 || (intent !== "apply" && intent !== "discard")) {
    throw data("Bad request", { status: 400, headers: HEADERS });
  }
  const result = intent === "apply" ? await applyVillageProposal(db, user.id, params.id, version) : await discardVillageProposalReview(db, user.id, params.id, version);
  if (result.ok) return redirect(result.village ? `/v/${result.village}` : "/villages", { status: 303, headers: HEADERS });
  if (result.error === "not_found") throw notFound();
  return data({ error: result.error }, { status: 409, headers: HEADERS });
}

function Fields({ values, reset }: { values: { name: string | null; description: string | null; icon: string | null }; reset?: boolean }) {
  return <dl className="space-y-3">
    {values.name !== null && <div><dt className="font-medium">{m.village_name_field()}</dt><dd className="break-words" dir="auto">{values.name}</dd></div>}
    {values.description !== null && <div><dt className="font-medium">{m.village_description_field()}</dt><dd className="whitespace-pre-wrap break-words" dir="auto">{values.description || m.village_proposal_empty_description()}</dd></div>}
    {values.icon && <div><dt className="font-medium">{m.village_icon_label()}</dt><dd><VillageIcon src={values.icon} className="size-20 rounded-md object-cover" />{reset && <span>{m.village_icon_reset()}</span>}</dd></div>}
  </dl>;
}

export default function VillageProposal({ loaderData, actionData }: Route.ComponentProps) {
  const { review, target } = loaderData;
  const navigation = useNavigation();
  const villageUrl = `/v/${target.village}`;
  const submitting = navigation.state !== "idle";
  const stale = !review || actionData?.error === "stale";
  return <main className="space-y-5">
    <h1 className="text-2xl font-bold">{m.village_proposal_title()}</h1>
    <p><Link className="underline" to={villageUrl}>/v/{target.village}</Link></p>
    {stale ? <p role="alert">{m.village_proposal_stale()}</p> : <>
      <p>{m.village_proposal_client({ client: `\u2068${review.clientName}\u2069` })}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="space-y-2 rounded-md border p-4"><h2 className="font-semibold">{m.village_proposal_before()}</h2><Fields values={review.before} /></section>
        <section className="space-y-2 rounded-md border p-4"><h2 className="font-semibold">{m.village_proposal_after()}</h2><Fields values={review.after} reset={review.iconAction === "reset"} /></section>
      </div>
      {actionData?.error === "image_limit" && <p role="alert">{m.village_proposal_image_limit()}</p>}
    </>}
    <Form method="post" className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="version" value={target.version} />
      {!stale && <Button type="submit" name="intent" value="apply" disabled={submitting}>{m.village_proposal_apply()}</Button>}
      <Button type="submit" variant="outline" name="intent" value="discard" disabled={submitting}>{m.village_proposal_discard()}</Button>
    </Form>
  </main>;
}
