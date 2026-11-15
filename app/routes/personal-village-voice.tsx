import { data, Form, Link, redirect } from "react-router";
import type { Route } from "./+types/personal-village-voice";
import { NushiVoicePublic, NushiVoiceSetting } from "~/components/nushi-voice";
import { VillageReportForm } from "~/components/village-moderation";
import { Button } from "~/components/ui/button";
import { getReader, requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { nushiEnabled, nushiVoiceEnabled } from "~/lib/nushi-config.server";
import { chatNushiEnabled } from "~/lib/chat-nushi-config.server";
import { personalVoiceVillage, publicNushiVoice, setNushiVoice } from "~/lib/nushi-voice.server";
import { createVillageReport, openVillageReportTargets } from "~/lib/village-moderation.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { readingHeaders } from "~/lib/public-reading.server";
import { getViewer } from "~/lib/roles.server";
import { m } from "~/paraglide/messages.js";

export function headers() { return readingHeaders(); }
export function meta() { return [{ title: m.nushi_voice_title() }]; }
const gate = () => { if (!villagesEnabled() || !nushiVoiceEnabled()) throw data("Not found", { status: 404 }); };

export async function loader({ request, params }: Route.LoaderArgs) {
  gate();
  const { db, user } = await getReader(request);
  const village = await personalVoiceVillage(db, params.handle);
  if (!village) throw data("Not found", { status: 404 });
  const owner = user?.id === village.ownerId;
  return { voice: (await publicNushiVoice(db, village.id))!, handle: village.slug.slice(1), owner, ended: !!village.endedAt,
    setting: owner && (nushiEnabled() || chatNushiEnabled()) ? { id: village.id, enabled: village.nushiEnabled === true } : null,
    operator: user ? (await getViewer(db, user)).scope.operator : false,
    reported: user ? await openVillageReportTargets(db, village.id, user.id) : null };
}

export async function action({ request, params }: Route.ActionArgs) {
  gate();
  assertSameOrigin(request);
  const { db, user } = await requireWriter(request);
  const village = await personalVoiceVillage(db, params.handle);
  if (!village) throw data("Not found", { status: 404 });
  const form = await request.formData(), intent = form.get("intent");
  if (intent === "flag") {
    await enforceMemberLimit(db, "report", user.id);
    const result = await createVillageReport(db, user.id, { slug: village.slug, target: form.get("target"), reason: form.get("reason"), note: form.get("note") });
    if (!result.ok) return data({ error: result.error }, { status: result.error === "forbidden" ? 403 : 400 });
    return { reported: true };
  }
  if (intent !== "nushi-voice" && intent !== "nushi-voice-clear") throw data("Bad request", { status: 400 });
  await enforceMemberLimit(db, "edit", user.id);
  const result = await setNushiVoice(db, user.id, village.id, intent === "nushi-voice-clear" ? "" : form.get("voice"));
  if (!result.ok) return data({ error: result.error }, { status: result.error === "forbidden" ? 403 : result.error === "not_found" ? 404 : 400 });
  throw redirect(`/v/personal/${params.handle}?manage=1#nushi-voice`);
}

export default function PersonalVillageVoice({ loaderData: value, actionData }: Route.ComponentProps) {
  return <main className="space-y-4">
    <h1 className="heading-1">{m.village_personal_destination({ handle: value.handle })}</h1>
    <Link className="underline" to={`/u/${value.handle}#village`}>{m.village_posts_tab()}</Link>
    {actionData && "error" in actionData && <p role="alert">{actionData.error === "invalid_voice" ? m.nushi_voice_invalid() : m.flag_error()}</p>}
    {actionData && "reported" in actionData && <p role="status">{m.flag_thanks()}</p>}
    <NushiVoicePublic voice={value.voice} />
    {value.owner && !value.ended && <details id="village-management" open><summary className="cursor-pointer underline">{m.village_manage()}</summary>
      {value.setting && <Form method="post" action="/nushi/action" className="space-y-2 ui-help"><input type="hidden" name="intent" value="village" /><input type="hidden" name="villageId" value={value.setting.id} /><input type="hidden" name="returnTo" value={`/v/personal/${value.handle}`} /><label><input type="checkbox" name="enabled" value="1" defaultChecked={value.setting.enabled} /> {m.nushi_enable()}</label><Button type="submit" variant="outline">{m.save_changes()}</Button></Form>}
      <NushiVoiceSetting text={value.voice.text} />
    </details>}
    {value.operator && !value.owner && <Link className="underline" to={`/mod/village/@${value.handle}`}>{m.village_mod_link()}</Link>}
    {!value.owner && value.reported && <VillageReportForm reported={value.reported} voiceOnly hasVoice={!!value.voice.text} />}
  </main>;
}
