import { assertSameOrigin } from "~/lib/http/csrf.server";
import { requireWriter } from "~/lib/auth/session.server";
import { avatarUploadAction } from "~/lib/avatar-upload.server";
import { requireVillageIconOwner, setVillageIcon } from "~/lib/village-icon.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";

export async function action({ request, params }: { request: Request; params: { slug: string } }) {
  if (!villagesEnabled()) throw new Response(null, { status: 404 });
  assertSameOrigin(request);
  return avatarUploadAction(request, await requireWriter(request), (db, userId, image) => setVillageIcon(db, userId, params.slug, image), (db, userId) => requireVillageIconOwner(db, userId, params.slug));
}
export function loader() { return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } }); }
