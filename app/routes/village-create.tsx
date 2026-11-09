import { data, Form, redirect, Link } from "react-router";
import type { Route } from "./+types/village-create";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { createVillage } from "~/lib/village-management.server";
import { villageError } from "~/lib/village-errors";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { VILLAGE_DESCRIPTION_MAX, VILLAGE_NAME_MAX, VILLAGE_SLUG_MAX } from "~/lib/villages";
import { VillageSourceLang } from "~/components/village-source-lang";
import { memberVillageLang } from "~/lib/village-translations.server";
import { m } from "~/paraglide/messages.js";

export function meta() { return [{ title: m.village_create() }]; }
export async function loader({ request }: Route.LoaderArgs) {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  const { profile } = await requireWriter(request);
  return { sourceLang: memberVillageLang(profile) };
}
export async function action({ request }: Route.ActionArgs) {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  assertSameOrigin(request);
  const { db, user } = await requireWriter(request);
  const form = await request.formData();
  const result = await createVillage(db, user.id, { slug: form.get("slug"), kind: form.get("kind"), name: form.get("name"), description: form.get("description"), sourceLang: form.get("sourceLang") });
  if (!result.ok) return data({ error: result.error }, { status: result.error === "forbidden" ? 403 : result.error === "rate_limited" ? 429 : 400 });
  throw redirect(`/v/${result.slug}`);
}
export default function VillageCreate({ actionData, loaderData: { sourceLang } }: Route.ComponentProps) {
  return <main className="max-w-xl space-y-4 [overflow-wrap:anywhere]">
    <h1 className="text-2xl font-bold">{m.village_create()}</h1>
    {actionData?.error && <p role="alert">{villageError(actionData.error)}</p>}
    <Form method="post" className="space-y-4">
      <fieldset className="space-y-2"><legend className="font-semibold">{m.village_kind()}</legend>
        <label className="flex gap-2"><input type="radio" name="kind" value="open" defaultChecked />{m.village_kind_open_option()}</label>
        <label className="flex gap-2"><input type="radio" name="kind" value="invite_public" />{m.village_kind_invite_option()}</label>
        <p className="ui-help text-muted-foreground">{m.village_kind_fixed()}</p>
      </fieldset>
      <label className="block space-y-1"><span>{m.village_name_field()}</span><Input name="name" required maxLength={VILLAGE_NAME_MAX} /></label>
      <div className="space-y-1"><label htmlFor="village-slug">{m.village_slug_field()}</label><Input id="village-slug" name="slug" required maxLength={VILLAGE_SLUG_MAX} pattern="[a-z0-9]+(-[a-z0-9]+)*" autoCapitalize="none" autoCorrect="off" aria-describedby="village-slug-help" /><p id="village-slug-help" className="ui-help text-muted-foreground">{m.village_slug_help()}</p></div>
      <label className="block space-y-1"><span>{m.village_description_field()}</span><Textarea name="description" maxLength={VILLAGE_DESCRIPTION_MAX} /></label>
      <VillageSourceLang id="village-source-lang" defaultValue={sourceLang} />
      <div className="flex flex-wrap gap-3"><Button type="submit">{m.village_create()}</Button><Link to="/villages" className="self-center underline">{m.cancel()}</Link></div>
    </Form>
  </main>;
}
