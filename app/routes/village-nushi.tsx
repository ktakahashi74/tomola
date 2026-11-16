import { data, Link, redirect } from "react-router";
import type { Route } from "./+types/village-nushi";
import { NushiVoicePublic, NushiVoiceSetting } from "~/components/nushi-voice";
import { VillageReportForm } from "~/components/village-moderation";
import { getReader, requireWriter } from "~/lib/auth/session.server";
import { villageReaderFor } from "~/lib/display-lang.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { publicNushiVoice, setNushiVoice, villageNushiAvailable } from "~/lib/nushi-voice.server";
import { readingHeaders } from "~/lib/public-reading.server";
import { getViewer } from "~/lib/roles.server";
import { createVillageReport, openVillageReportTargets } from "~/lib/village-moderation.server";
import { villageName } from "~/lib/village-name";
import { localizeVillage } from "~/lib/village-translations.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { publicVillage, villageBySlug, villageMembership } from "~/lib/villages.server";
import { m } from "~/paraglide/messages.js";

export function headers() { return readingHeaders(); }
export function meta() { return [{ title: m.village_nushi_title() }]; }
const gate = () => { if (!villagesEnabled()) throw data("Not found", { status: 404 }); };

export async function loader({ request, params }: Route.LoaderArgs) {
  gate();
  const { db, user, profile } = await getReader(request);
  const village = await villageBySlug(db, params.slug);
  if (!village?.slug || !await villageNushiAvailable(db, village)) throw data("Not found", { status: 404 });
  const owner = user ? (await villageMembership(db, village.id, user.id)).owner : false;
  const localized = await localizeVillage(db, publicVillage(village), villageReaderFor(request, profile));
  const voice = await publicNushiVoice(db, village.id);
  return { village: { slug: village.slug, name: villageName(localized) }, owner, ended: !!village.endedAt,
    ...(voice ? { voice } : {}),
    operator: user ? (await getViewer(db, user)).scope.operator : false,
    reported: user ? await openVillageReportTargets(db, village.id, user.id) : null };
}

export async function action({ request, params }: Route.ActionArgs) {
  gate();
  assertSameOrigin(request);
  const { db, user } = await requireWriter(request);
  const village = await villageBySlug(db, params.slug);
  if (!village?.slug || !await villageNushiAvailable(db, village)) throw data("Not found", { status: 404 });
  const form = await request.formData(), intent = form.get("intent");
  if (intent === "flag") {
    if (form.get("target") !== "nushi_voice") throw data("Bad request", { status: 400 });
    await enforceMemberLimit(db, "report", user.id);
    const result = await createVillageReport(db, user.id, { slug: village.slug, target: form.get("target"), voiceEventId: form.get("voiceEventId"), reason: form.get("reason"), note: form.get("note") });
    if (!result.ok) return data({ error: result.error }, { status: result.error === "forbidden" ? 403 : result.error === "not_found" ? 404 : 400 });
    return { reported: true };
  }
  if (intent !== "nushi-voice" && intent !== "nushi-voice-clear") throw data("Bad request", { status: 400 });
  await enforceMemberLimit(db, "edit", user.id);
  const result = await setNushiVoice(db, user.id, village.id, intent === "nushi-voice-clear" ? "" : form.get("voice"));
  if (!result.ok) return data({ error: result.error }, { status: result.error === "forbidden" ? 403 : result.error === "not_found" ? 404 : 400 });
  throw redirect(`/v/${village.slug}/nushi?manage=1#nushi-voice`);
}

export default function VillageNushi({ loaderData: value, actionData }: Route.ComponentProps) {
  return <main className="space-y-4">
    <h1 className="heading-1">{m.village_nushi_title()}</h1>
    <Link className="underline" to={`/v/${value.village.slug}`}>{value.village.name}</Link>
    <p>{m.nushi_description()} <Link className="underline" to="/ai-use#nushi">{m.ai_use_title()}</Link></p>
    {actionData && "error" in actionData && <p role="alert">{actionData.error === "invalid_voice" ? m.nushi_voice_invalid() : m.flag_error()}</p>}
    {actionData && "reported" in actionData && <p role="status">{m.flag_thanks()}</p>}
    {value.voice && <NushiVoicePublic voice={value.voice} />}
    {value.owner && !value.ended && value.voice && <details id="village-management" open><summary className="cursor-pointer underline">{m.village_manage()}</summary>
      <NushiVoiceSetting text={value.voice.text} />
    </details>}
    {value.operator && !value.owner && <Link className="underline" to={`/mod/village/${value.village.slug}`}>{m.village_mod_link()}</Link>}
    {!value.owner && value.reported && value.voice && <VillageReportForm reported={value.reported} voiceOnly voiceHistory={value.voice.history} />}
  </main>;
}
