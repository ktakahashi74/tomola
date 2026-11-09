import { assertSameOrigin } from "~/lib/http/csrf.server";
import { requireWriter } from "~/lib/auth/session.server";
import { avatarUploadAction } from "~/lib/avatar-upload.server";
import { setMemberAvatar } from "~/lib/member-avatar.server";

export async function action({ request }: { request: Request }) {
  assertSameOrigin(request);
  return avatarUploadAction(request, await requireWriter(request), setMemberAvatar);
}
export function loader() { return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } }); }
