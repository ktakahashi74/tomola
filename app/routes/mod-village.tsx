import { data, Link } from "react-router";
import type { Route } from "./+types/mod-village";
import { VillageModerationCard } from "~/components/village-moderation";
import { requireOperator } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { loadVillageModerationView } from "~/lib/village-moderation.server";
import { action as modAction } from "~/routes/mod";
import { errorText } from "~/lib/mod-error-text";
import { m } from "~/paraglide/messages.js";

export { shouldRevalidate } from "~/routes/mod";

export function meta() { return [{ title: m.village_mod_link() }]; }
export async function loader({ request, params }: Route.LoaderArgs) {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  const { db, user } = await requireOperator(request);
  await enforceMemberLimit(db, "mod", user.id);
  const card = await loadVillageModerationView(db, params.slug, user.id);
  if (!card || card.owned || card.village.language) throw data("Not found", { status: 404 });
  return { card: { ...card, reports: card.reports.map(r => ({ ...r, createdAt: r.createdAt.toISOString().slice(0, 10) })) } };
}
export async function action(args: Route.ActionArgs) {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  assertSameOrigin(args.request);
  await requireOperator(args.request);
  // The shared action applies CSRF, writer and moderation gates to all intents.
  return modAction(args);
}
export default function ModVillage({ loaderData, actionData }: Route.ComponentProps) {
  return <main className="space-y-4">
    <h1 className="text-2xl font-bold">{m.village_mod_link()}</h1>
    <Link className="underline" to="/mod">{m.mod_title()}</Link>
    {actionData?.error && <p role="alert">{errorText(actionData.error)}</p>}
    <VillageModerationCard card={loaderData.card} handled={false} returnTo="/mod" />
  </main>;
}
