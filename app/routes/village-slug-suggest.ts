import { data } from "react-router";
import type { Route } from "./+types/village-slug-suggest";
import { requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { villageSlugSuggestEnabled } from "~/lib/village-slug-suggest-config.server";
import { suggestVillageSlug } from "~/lib/village-slug-suggest.server";

export function loader() { throw data("Method not allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } }); }

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (request.method !== "POST") throw data("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (!villageSlugSuggestEnabled()) throw data("Not found", { status: 404 });
  const { db, user } = await requireWriter(request);
  const form = await request.formData();
  const slug = await suggestVillageSlug(db, user.id, form.get("name"), { signal: request.signal });
  return Response.json({ slug }, { headers: { "Cache-Control": "no-store" } });
}
