import { data, Form, Link } from "react-router";
import type { Route } from "./+types/settings-media";
import { Button } from "~/components/ui/button";
import { requireMember } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { deleteOwnMedia, listOwnMedia } from "~/lib/media-store.server";
import { mediaPath } from "~/lib/media";
import { m } from "~/paraglide/messages.js";
import { ListMeta } from "~/components/list-meta";

export const meta = () => [{ title: m.settings_media_title() }];
export const headers = () => ({ "Cache-Control": "private, no-store" });
export async function loader({ request }: Route.LoaderArgs) {
  const { db, user } = await requireMember(request);
  return { images: await listOwnMedia(db, user.id) };
}
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user } = await requireMember(request);
  const form = await request.formData();
  if (form.get("confirm") !== "1") throw data("Bad request", { status: 400 });
  const usage = String(form.get("usage_count") ?? "");
  if (!/^\d+$/.test(usage) || !Number.isSafeInteger(Number(usage))) throw data("Bad request", { status: 400 });
  const id = String(form.get("id") ?? "");
  const result = await deleteOwnMedia(db, user.id, id, Number(usage));
  if (result.status === "not_found") throw data("Not found", { status: 404 });
  if (result.status === "confirmation_required") return data({ deleted: false as const, id, usedByOwnPosts: result.usedByOwnPosts }, { status: 409 });
  return { deleted: true as const };
}
export default function SettingsMedia({ loaderData, actionData }: Route.ComponentProps) {
  return <main className="space-y-4">
    <Link className="link-ui" to="/settings">{m.settings_title()}</Link>
    <h1 className="text-2xl font-bold">{m.settings_media_title()}</h1>
    {actionData?.deleted && <p role="status">{m.media_deleted()}</p>}
    {actionData && !actionData.deleted && <p role="alert">{m.media_delete_usage_changed()}</p>}
    {!loaderData.images.length && <p className="ui-help text-muted-foreground">{m.settings_media_empty()}</p>}
    <ul className="space-y-4">{loaderData.images.map(image => {
      const usage = actionData && !actionData.deleted && actionData.id === image.id ? actionData.usedByOwnPosts : image.usedByOwnPosts;
      return <li key={image.id} className="space-y-2 rounded border p-3">
      <img src={mediaPath(image.id, image.width, image.height)} width={image.width} height={image.height} loading="lazy" alt="" className="max-h-40 w-auto max-w-full object-contain" />
      <ListMeta items={[
        { key: "uploaded", content: <time dateTime={image.uploadedAt.toISOString()}>{image.uploadedAt.toISOString().slice(0, 10)}</time> },
        { key: "dimensions", content: `${image.width} × ${image.height}` },
        { key: "size", content: `${Math.ceil(image.byteSize / 1024)} KiB` },
      ]} />
      {usage > 0 && <p>{m.media_used_posts({ count: usage })}</p>}
      <Form key={usage} method="post" className="space-y-2"><input type="hidden" name="id" value={image.id} /><input type="hidden" name="usage_count" value={usage} /><label className="flex gap-2"><input type="checkbox" name="confirm" value="1" required />{m.media_delete_confirm()}</label><Button type="submit" variant="destructive">{m.media_delete()}</Button></Form>
    </li>})}</ul>
  </main>;
}
