import { pushConfig, webPushEnabled } from "~/lib/push/config.server";
import { currentPushId, stopPush } from "~/lib/push/subscriptions.server";
import { SettingsSaveStatus, useSettingsAutosave } from "~/components/settings-autosave";
import { AvatarSettings } from "~/components/avatar-settings";
import { InstallGuideSettings } from "~/components/install-guide-settings";
import { DisplayNameFields } from "~/components/display-name-fields";
import { memberAvatarUrl } from "~/lib/member-avatar.server";
import { updateDisplayNames } from "~/lib/display-names.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { PersistentDetails } from "~/components/persistent-details";
import { usePageReady } from "~/components/quiet-boundary";
import { Textarea } from "~/components/ui/textarea";
import { CopyTextButton } from "~/components/copy-text-button";
import { DigestTime } from "~/components/digest-time";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "~/components/ui/field";
import { HandleInput } from "~/components/handle-input";
import { Button } from "~/components/ui/button";
import { NativeSelect, NativeSelectOption } from "~/components/ui/native-select";
import { Checkbox } from "~/components/ui/checkbox";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { data, Form, Link, redirect, useLocation } from "react-router";
import type { Route } from "./+types/settings";
import { LocaleSwitcher } from "~/components/locale-switcher";
import { OpenInAiSettings } from "~/components/open-in-ai";
import { PasskeySettings } from "~/components/passkey-settings";
import { PasskeyPrompt } from "~/components/passkey-prompt";
import { getAuth } from "~/lib/auth/auth.server";
import { getCredentialSessionFresh, requireMember, requireWriter } from "~/lib/auth/session.server";
import { getWriter } from "~/lib/members.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { LANG_LABELS, type Area } from "~/lib/languages";
import { getLocale } from "~/paraglide/runtime.js";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { revokeOpenInAiLinks } from "~/lib/open-in-ai.server";
import { EMAIL_PREFS } from "~/lib/notifications";
import { changeHandle, changeHomeArea, nextHandleChangeAt, nextHomeAreaChangeAt, setEmailPref, updatePreferences } from "~/lib/profiles.server";
import { HOME_AREA_CHANGE_DAYS } from "~/lib/profile-settings";
import { removeOwnPasskey } from "~/lib/auth/passkeys.server";
import { SigningFailureResponse, signingPreferenceValue, withSignedWrite } from "~/lib/signing.server";
import { eq } from "drizzle-orm";
import { profiles } from "~/lib/db/schema";
import { SignedForm } from "~/components/signed-form";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { villageReaderFor } from "~/lib/display-lang.server";
import { postingVillages, setDefaultVillage, villageSlug } from "~/lib/villages.server";
import { villageName } from "~/lib/village-name";
import { m } from "~/paraglide/messages.js";
import { siteUrl } from "~/lib/site-url";
import { shareBookmarklet } from "~/lib/share-bookmarklet";
import { withSettingsReturn } from "~/lib/settings-return";
import { settingsReturnFromRequest } from "~/lib/settings-return.server";
import { SettingsReturnLink } from "~/components/settings-return-link";

const PushSettings = lazy(() => import("~/components/push-settings"));

export const handle = { PasskeyPrompt };

export function meta({}: Route.MetaArgs) {
  return [{ title: m.settings_title() }];
}

const dateOf = (d: Date) => d.toISOString().slice(0, 10);

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const { profile, db, user } = await requireMember(request);
  // Passkey list: call auth.api directly server-side because HTTP endpoints are closed. Do not send public keys or similar data to the UI.
  const auth = await getAuth();
  const passkeys = (await auth.api.listPasskeys({ headers: request.headers }))
    .map((p) => ({ id: p.id, name: p.name ?? null, createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null, backedUp: p.backedUp }))
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const next = nextHomeAreaChangeAt(profile);
  const nextHandle = nextHandleChangeAt(profile);
  const saved = new URL(request.url).searchParams.get("saved");
  const [avatar] = await db.select({ publicId: profiles.publicId, avatarMediaId: profiles.avatarMediaId }).from(profiles).where(eq(profiles.userId, user.id));
  return {
    ...(villageChatEnabled() ? { chatOwn: true } : {}),
    avatarUrl: memberAvatarUrl(avatar)!,
    avatarUploaded: !!avatar?.avatarMediaId,
    returnTo: settingsReturnFromRequest(request),
    homeArea: profile.homeArea,
    handle: profile.handle,
    displayName: profile.displayName ?? null,
    displayNameLatin: profile.displayNameLatin ?? null,
    nextHandleChange: nextHandle !== null && nextHandle > new Date() ? dateOf(nextHandle) : null,
    signPosts: profile.signPosts,
    displayLang: profile.displayLang,
    readLangs: profile.readLangs,
    // While a language-area change is unavailable, provide the next allowed date (UTC); otherwise null, including for the first change.
    nextAreaChange: next !== null && next > new Date() ? dateOf(next) : null,
    saved: saved === "display-name" || saved === "preferences" || saved === "ai-links" || saved === "passkey-removed" || saved === "email" || saved === "handle" || saved === "sign-posts" || saved === "sessions" ? saved : null,
    ...(webPushEnabled() ? { push: { publicKey: pushConfig()!.publicKey } } : {}),
    emailPref: profile.emailPref,
    passkeys,
    credentialFresh: await getCredentialSessionFresh(request),
    shareBookmarklet: shareBookmarklet(siteUrl()),
    ...(villagesEnabled() ? { posting: await postingVillages(db, user.id, undefined, { repair: false, reader: villageReaderFor(request, profile) }) } : {}),
  };
}

class LanguageSettingsError extends Error {
  constructor(readonly code: string, readonly date: string | null = null) { super(code); }
}

// The language form saves atomically; a main-language change requires explicit
// confirmation and is checked under the same profile lock as its cooldown.
export async function action(args: { request: Request }) {
  const retained = args.request.clone();
  try { return await settingsAction(args); }
  catch (error) {
    if (!(error instanceof SigningFailureResponse)) throw error;
    const form = await retained.formData();
    const intent = formString(form, "intent");
    if (intent === "display-name") return data({ intent, error: error.code, displayName: formString(form, "displayName"), displayNameLatin: formString(form, "displayNameLatin") } as const, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
    if (intent !== "handle" && intent !== "delete-passkey") throw error;
    return data({ intent, error: error.code, date: null, handleValue: formString(form, "handle") } as const, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
  }
}

async function settingsAction({ request }: { request: Request }) {
  // Reject all changes from cross-site POSTs (CSRF), checking before authentication or input parsing (csrf.server.ts convention).
  assertSameOrigin(request);
  const { user, db } = await requireMember(request);
  const form = await request.formData();
  const returnTo = settingsReturnFromRequest(request);
  if (formString(form, "intent") === "sign-posts") {
    try {
      await withSignedWrite(db, user.id, request, form, async tx => {
        await tx.update(profiles).set({ signPosts: signingPreferenceValue(form) }).where(eq(profiles.userId, user.id));
        return { ok: true };
      });
    } catch (error) {
      if (!(error instanceof Response) || error.status < 400 || error.status >= 500) throw error;
      const result = await error.clone().json();
      return data({ intent: "sign-posts" as const, error: String(result.error), date: null }, { status: error.status });
    }
    throw redirect(withSettingsReturn("/settings?saved=sign-posts#settings-signing", returnTo));
  }
  if (formString(form, "intent") === "revoke-other-sessions") {
    if (webPushEnabled()) {
      const id = await currentPushId(db, user.id, { id: form.get("push-id"), secret: form.get("push-secret") });
      await stopPush(db, user.id, null, "other_sessions_revoked", id ?? undefined);
    }
    await (await getAuth()).api.revokeOtherSessions({ request, headers: request.headers });
    throw redirect(withSettingsReturn("/settings?saved=sessions#settings-sessions", returnTo));
  }
  // Delete only the member's own passkeys after a signed approval; the final credential cannot be removed.
  if (formString(form, "intent") === "delete-passkey") {
    const res = await withSignedWrite(db, user.id, request, form, tx => removeOwnPasskey(tx, user.id, formString(form, "passkeyId")));
    if (!res.ok) throw data("Not found", { status: 404 });
    throw redirect(withSettingsReturn("/settings?saved=passkey-removed#settings-passkeys", returnTo));
  }
  if (formString(form, "intent") === "display-name") {
    await requireWriter(request);
    const res = await withSignedWrite(db, user.id, request, form, tx => updateDisplayNames(tx, user.id, formString(form, "displayName"), formString(form, "displayNameLatin")));
    if (res.ok) throw redirect(withSettingsReturn("/settings?saved=display-name#settings-display-name", returnTo));
    return data({ intent: "display-name" as const, error: res.error, displayName: formString(form, "displayName"), displayNameLatin: formString(form, "displayNameLatin") }, { status: res.error === "rate_limited" ? 429 : 400 });
  }
  if (formString(form, "intent") === "handle") {
    await requireWriter(request);
    const res = await withSignedWrite(db, user.id, request, form, tx => changeHandle(tx, user.id, formString(form, "handle")));
    if (res.ok) throw redirect(withSettingsReturn("/settings?saved=handle#settings-handle", returnTo));
    return data({ intent: "handle" as const, error: res.error, date: res.error === "too_soon" ? dateOf(res.nextChangeAt) : null }, { status: 400 });
  }
  // Notification email preferences: automatic, all immediate, all daily digest, or none.
  if (formString(form, "intent") === "email-pref") {
    const res = await setEmailPref(db, user.id, formString(form, "emailPref"));
    if (formString(form, "autosave") === "1") return Response.json(res.ok ? { ok: true, value: formString(form, "emailPref") } : { ok: false, error: res.error }, { status: res.ok ? 200 : 400, headers: { "Cache-Control": "private, no-store" } });
    if (res.ok) throw redirect(withSettingsReturn("/settings?saved=email#settings-email", returnTo));
    return data({ intent: "email" as const, error: res.error, date: null }, { status: 400 });
  }
  // Invalidate all signed 「AIで開く」 links by incrementing their generation.
  if (formString(form, "intent") === "revoke-ai-links") {
    await revokeOpenInAiLinks(db, user.id);
    throw redirect(withSettingsReturn("/settings?saved=ai-links#settings-links", returnTo));
  }
  if (formString(form, "intent") !== "preferences") throw data("Bad request", { status: 400 });
  const field = formString(form, "field");
  if (field && !["homeArea", "readLangs", "displayLang", "village"].includes(field)) throw data("Bad request", { status: 400 });
  const autosave = formString(form, "autosave") === "1";
  if (autosave && !["readLangs", "displayLang", "village"].includes(field)) throw data("Bad request", { status: 400 });
  let savedValue: string | string[] = "";
  const values = {
    homeArea: formString(form, "homeArea"), displayLang: formString(form, "displayLang"),
    readLangs: form.getAll("readLangs").map(String), village: formString(form, "village"),
  };
  try {
    await db.transaction(async tx => {
      const [current] = await tx.select().from(profiles).where(eq(profiles.userId, user.id)).for("update");
      if (!current) throw new LanguageSettingsError("not_found");
      if ((!field || field === "homeArea") && values.homeArea !== current.homeArea) {
        if (formString(form, "confirmHomeArea") !== "1") throw new LanguageSettingsError("confirm_area");
        const area = await changeHomeArea(tx, user.id, values.homeArea);
        if (!area.ok) throw new LanguageSettingsError(area.error, area.error === "too_soon" ? dateOf(area.nextChangeAt) : null);
      }
      if (!field || field === "readLangs" || field === "displayLang") {
        const input = field === "readLangs" ? { readLangs: values.readLangs } : field === "displayLang" ? { displayLang: values.displayLang } : values;
        const preferences = await updatePreferences(tx, user.id, input);
        if (!preferences.ok) throw new LanguageSettingsError(preferences.error);
      }
      if (field === "village" && (!villagesEnabled() || !values.village.trim())) throw new LanguageSettingsError("village_required");
      if ((!field || field === "village") && villagesEnabled() && values.village.trim()) {
        const effectiveDefault = await villageSlug(tx, current.defaultVillageId) ?? `@${current.handle}`;
        if (values.village.trim().toLowerCase() !== effectiveDefault) {
          const writer = await getWriter(tx, user.id);
          if (!writer.ok) throw redirect(writer.reason === "suspended" ? "/suspended" : "/onboarding");
          if (!await setDefaultVillage(tx, user.id, values.village)) throw new LanguageSettingsError("village_required");
        }
      }
      if (autosave) {
        const [updated] = await tx.select().from(profiles).where(eq(profiles.userId, user.id));
        savedValue = field === "readLangs" ? updated.readLangs : field === "displayLang" ? updated.displayLang ?? "" : values.village.trim().toLowerCase();
      }
    });
  } catch (error) {
    if (!(error instanceof LanguageSettingsError)) throw error;
    if (autosave) return Response.json({ ok: false, error: error.code }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
    return data({ intent: "preferences" as const, error: error.code, date: error.date, values }, { status: 400 });
  }
  if (autosave) return Response.json({ ok: true, value: savedValue }, { headers: { "Cache-Control": "private, no-store" } });
  throw redirect(withSettingsReturn("/settings?saved=preferences#settings-languages", returnTo));
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { homeArea, displayLang, readLangs, nextAreaChange, saved, passkeys, emailPref, handle, signPosts, nextHandleChange, returnTo } = loaderData;
  const values = actionData?.intent === "preferences" ? actionData.values : undefined;
  const displayNames = actionData?.intent === "display-name" ? actionData : loaderData;
  const defaultVillageAvailable = loaderData.posting?.choices.some(village => village.slug === loaderData.posting?.selected);
  const [areaChoice, setAreaChoice] = useState(values?.homeArea ?? homeArea);
  const displayedArea = nextAreaChange ? homeArea : areaChoice;
  const areaChanged = displayedArea !== homeArea;
  const enhanced = usePageReady();
  const readControl = useRef<HTMLFieldSetElement>(null);
  const displayControl = useRef<HTMLSelectElement>(null);
  const destinationControl = useRef<HTMLSelectElement>(null);
  const emailControl = useRef<HTMLDivElement>(null);
  const read = useSettingsAutosave(values?.readLangs ?? readLangs, "readLangs", readControl);
  const display = useSettingsAutosave(values?.displayLang ?? displayLang ?? "", "displayLang", displayControl);
  const destination = useSettingsAutosave(values?.village || (defaultVillageAvailable ? loaderData.posting!.selected : ""), "village", destinationControl);
  const email = useSettingsAutosave(emailPref, "emailPref", emailControl);
  const advanced = useRef<HTMLDetailsElement>(null);
  const aiLinks = useRef<HTMLDetailsElement>(null);
  const { hash, key: locationKey } = useLocation();
  const [selectedSection, setSelectedSection] = useState("");
  const firstResponse = useRef({ saved, actionData, hash, locationKey });
  useEffect(() => {
    let frame = 0;
    const reveal = () => {
      let id: string;
      try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
      const target = id ? document.getElementById(id) : null;
      setSelectedSection(target?.closest("main > section, main > details")?.id ?? "");
      for (const details of [advanced.current, aiLinks.current, target?.closest("details")]) {
        if (target && details?.contains(target) && !details.open) {
          details.open = true;
          target.scrollIntoView();
        }
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(reveal); };
    // A saved section is already open in SSR. Respect a native close made
    // before hydration; subsequent saves and explicit hash changes still reveal it.
    const initial = firstResponse.current;
    const serverOpened = saved === "ai-links" ? aiLinks.current : saved === "sign-posts" || actionData?.intent === "sign-posts" ? advanced.current : null;
    if (!(serverOpened && initial.saved === saved && initial.actionData === actionData && initial.hash === hash && initial.locationKey === locationKey && !serverOpened.open)) schedule();
    window.addEventListener("hashchange", schedule);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("hashchange", schedule); };
  }, [hash, saved, actionData, locationKey]);
  useEffect(() => {
    if (actionData?.intent !== "sign-posts" || (actionData === firstResponse.current.actionData && advanced.current && !advanced.current.open)) return;
    const frame = requestAnimationFrame(() => {
      if (advanced.current) advanced.current.open = true;
      document.getElementById("settings-signing")?.scrollIntoView();
    });
    return () => cancelAnimationFrame(frame);
  }, [actionData]);
  const areaName = (a: Area) => (a === "other" ? m.area_other() : LANG_LABELS[a]);
  const langs = useEnabledLangs();
  // The main language choices: the enabled languages and "other". A current value that is not enabled (after a language was closed) stays at the end of the choices, marked "not open
  // at the moment", so that saving never silently changes it.
  const areaChoices: Area[] = [...langs, "other"];
  const closedArea = !areaChoices.includes(homeArea) ? homeArea : null;

  // What the translate-into setting does right now: the chosen language, or the interface language while it follows that.
  const translateInto = (display.value || getLocale()) as Area;
  const handleOpen = actionData?.intent === "handle";
  return (
    <main className="space-y-8">
      <h1 className="text-2xl font-bold">{m.settings_title()}</h1>
      {returnTo && <p><SettingsReturnLink to={returnTo} /></p>}

      <nav aria-label={m.settings_title()}>
        <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-2 ui-meta">
          {[
            ["settings-languages", m.settings_langs_heading()],
            ["settings-ai", m.settings_ai_section_heading()],
            ["settings-email", m.settings_email_heading()],
            ["settings-account", m.settings_account_heading()],
            ["settings-records", m.settings_records_heading()],
            ["settings-advanced", m.settings_advanced_heading()],
          ].map(([id, label]) => (
            <li key={id} className="min-w-0 max-w-full">
              <a href={`#${id}`} aria-current={selectedSection === id ? "location" : undefined} className="choice break-words">{label}</a>
            </li>
          ))}
        </ul>
      </nav>

      <section id="settings-languages" aria-labelledby="settings-languages-heading" className="scroll-mt-4 space-y-4">
        <h2 id="settings-languages-heading" className="text-xl font-semibold">{m.settings_langs_heading()}</h2>
        {saved === "preferences" && <p role="status" className="text-success">{m.settings_saved()}</p>}
        {actionData?.intent === "preferences" && <p role="alert" className="text-destructive">{
          actionData.error === "too_soon" && actionData.date ? m.settings_area_error_soon({ date: actionData.date }) :
          actionData.error === "confirm_area" ? m.settings_area_confirm_required({ days: HOME_AREA_CHANGE_DAYS }) :
          actionData.error === "invalid_area" ? m.settings_area_error_invalid() :
          actionData.error === "village_required" ? m.village_required() : m.error_generic()
        }</p>}
        {/* The interface language changes as soon as it is picked; it is the same switch as in the top row, here for finding it. */}
        <div className="space-y-2">
          <Field className="min-w-0 w-auto"><FieldLabel className="block">
            <span className="me-2">{m.language_select()}</span>
            <LocaleSwitcher />
          </FieldLabel></Field>
          <p className="ui-help text-muted-foreground">{m.settings_ui_lang_help()}</p>
        </div>
        {/* Ordinary submissions keep the combined no-JavaScript path. Enhanced saves name just the field being changed. */}
        <Form method="post" action={withSettingsReturn("/settings#settings-languages", returnTo)} className="space-y-4">
          <input type="hidden" name="intent" value="preferences" />
          {enhanced && <input type="hidden" name="field" value="homeArea" />}
          <FieldSet id="settings-read-langs" ref={readControl}>
            <FieldLegend>{m.onboarding_read_langs()}</FieldLegend>
            <FieldDescription>{m.settings_read_langs_help()}</FieldDescription>
            {langs.map(lang => <Field key={lang} orientation="horizontal" className="min-w-0 inline-flex w-auto"><FieldLabel className="flex items-center gap-2 me-3"><input type="checkbox" name="readLangs" value={lang} checked={read.value.includes(lang)} onChange={event => read.change(event.target.checked ? [...read.value.filter(value => langs.some(enabled => enabled === value)), lang] : read.value.filter(value => value !== lang && langs.some(enabled => enabled === value)))} /><span lang={lang}>{LANG_LABELS[lang]}</span></FieldLabel></Field>)}
            {enhanced && <SettingsSaveStatus {...read} />}
          </FieldSet>
          <section id="settings-area" aria-labelledby="settings-area-heading" className="scroll-mt-4 space-y-2">
            <Field className="min-w-0 w-auto"><FieldLabel id="settings-area-heading" htmlFor="settings-home-area">{m.onboarding_home_area()}</FieldLabel>
              <NativeSelect id="settings-home-area" name="homeArea" value={displayedArea} disabled={!!nextAreaChange} className="w-full" onChange={event => setAreaChoice(event.target.value)}>
                {areaChoices.map(area => <NativeSelectOption key={area} value={area} lang={area === "other" ? undefined : area}>{areaName(area)}</NativeSelectOption>)}
                {closedArea && <NativeSelectOption value={closedArea}>{m.lang_not_open({ lang: areaName(closedArea) })}</NativeSelectOption>}
              </NativeSelect>
            </Field>
            {nextAreaChange && <><input type="hidden" name="homeArea" value={homeArea} /><p className="ui-meta text-muted-foreground">{m.settings_area_next({ date: nextAreaChange })}</p></>}
            <p className="ui-help text-muted-foreground">{m.settings_area_short_help()}</p>
            {areaChanged && <>
              <Field orientation="horizontal"><FieldLabel className="flex items-start gap-2"><input type="checkbox" name="confirmHomeArea" value="1" required />{m.settings_area_confirm({ days: HOME_AREA_CHANGE_DAYS })}</FieldLabel></Field>
              {enhanced && <Button type="submit">{m.settings_area_change()}</Button>}
            </>}
            <details className="space-y-2 ui-help text-muted-foreground">
              <summary className="cursor-pointer ui-meta">{m.onboarding_language_details()}</summary>
              <p>{m.settings_area_help({ days: HOME_AREA_CHANGE_DAYS })}</p>
            </details>
          </section>
          <details className="space-y-3">
            <summary className="cursor-pointer ui-meta">{m.settings_language_advanced()}</summary>
            <Field id="settings-display-lang" className="min-w-0 w-auto"><FieldLabel htmlFor="settings-display-language">{m.display_lang_label()}</FieldLabel>
              <NativeSelect ref={displayControl} id="settings-display-language" name="displayLang" value={display.value} onChange={event => display.change(event.target.value)} className="w-full">
                <NativeSelectOption value="">{m.settings_display_auto()}</NativeSelectOption>
                {langs.map(lang => <NativeSelectOption key={lang} value={lang} lang={lang}>{LANG_LABELS[lang]}</NativeSelectOption>)}
              </NativeSelect>
              <FieldDescription>{m.settings_display_effect({ lang: areaName(translateInto) })}</FieldDescription>
              {enhanced && <SettingsSaveStatus {...display} />}
            </Field>
          </details>
          {loaderData.posting && <section id="settings-village" className="scroll-mt-4 space-y-2">
            <Field><FieldLabel htmlFor="settings-default-village">{m.settings_default_village()}</FieldLabel>
              <NativeSelect ref={destinationControl} id="settings-default-village" name="village" value={destination.value} onChange={event => destination.change(event.target.value)} className="w-full">
                {!defaultVillageAvailable && <NativeSelectOption value="">{loaderData.posting.choices.length === 0 ? m.village_target_none() : m.village_choose()}</NativeSelectOption>}
                {loaderData.posting.choices.filter(village => village.slug).map(village => <NativeSelectOption key={village.slug} value={village.slug!}>{villageName(village)}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
            {loaderData.posting.error && <FieldDescription>{m.village_target_unavailable()}</FieldDescription>}
            {enhanced && <SettingsSaveStatus {...destination} />}
          </section>}
          {!enhanced && <Button type="submit">{m.save_changes()}</Button>}
        </Form>

      </section>

      <section id="settings-ai" aria-labelledby="settings-ai-section-heading" className="scroll-mt-4 space-y-4">
        <h2 id="settings-ai-section-heading" className="text-xl font-semibold">{m.settings_ai_section_heading()}</h2>
        <OpenInAiSettings />
        <section id="settings-connect" aria-labelledby="settings-connect-heading" className="space-y-2">
          <h3 id="settings-connect-heading" className="text-lg font-semibold"><Link to="/connect" className="underline">{m.footer_connect()}</Link></h3>
          <p className="ui-help text-muted-foreground">{m.settings_connect_help()}</p>
          <p><Link to="/settings/connections" className="underline">{m.settings_connections_link()}</Link></p>
        </section>
        <PersistentDetails id="settings-links" ref={aiLinks} open={saved === "ai-links"} className="scroll-mt-4 space-y-3">
          <summary className="cursor-pointer">{m.settings_ai_links_revoke()}</summary>
          <p className="ui-help text-muted-foreground">{m.settings_ai_links_help()}</p>
          {saved === "ai-links" && <p role="status" className="text-success">{m.settings_ai_links_revoked()}</p>}
          <Form method="post" action={withSettingsReturn("/settings#settings-links", returnTo)}>
            <input type="hidden" name="intent" value="revoke-ai-links" />
            <Button type="submit" variant="outline" className="h-auto max-w-full whitespace-normal">{m.settings_ai_links_revoke()}</Button>
          </Form>
        </PersistentDetails>
      </section>

      {"push" in loaderData && loaderData.push && <Suspense fallback={null}><PushSettings publicKey={loaderData.push.publicKey} /></Suspense>}

      <section id="settings-email" aria-labelledby="settings-email-heading" className="scroll-mt-4 space-y-3">
        <h2 id="settings-email-heading" className="text-xl font-semibold">{m.settings_email_heading()}</h2>
        {saved === "email" && <p role="status" className="text-success">{m.settings_saved()}</p>}
        {actionData?.intent === "email" && actionData.error && <p role="alert" className="text-destructive">{m.settings_email_error()}</p>}
        <p className="ui-help text-muted-foreground">{m.settings_email_intro()}</p>
        <Form method="post" action={withSettingsReturn("/settings#settings-email", returnTo)} className="space-y-2">
          <input type="hidden" name="intent" value="email-pref" />
          <div ref={emailControl} role="radiogroup" aria-labelledby="settings-email-heading" className="grid gap-2">
          {EMAIL_PREFS.map((p) => (
            <Field key={p} orientation="horizontal" className="min-w-0 w-auto"><FieldLabel key={p} className="flex items-center gap-2 ">
              <input type="radio" name="emailPref" value={p} checked={email.value === p} onChange={() => email.change(p)} className="accent-primary" />{" "}
              {p === "auto" ? m.settings_email_auto() : p === "immediate" ? m.settings_email_immediate() : p === "daily" ? m.settings_email_daily() : m.settings_email_none()}
            </FieldLabel></Field>
          ))}
          </div>
          <FieldDescription className="ui-help text-muted-foreground"><DigestTime /></FieldDescription>
          {enhanced && <SettingsSaveStatus {...email} email />}
          {!enhanced && <Button type="submit">{m.settings_email_save()}</Button>}
        </Form>
      </section>

      <section id="settings-account" aria-labelledby="settings-account-heading" className="scroll-mt-4 space-y-8">
        <h2 id="settings-account-heading" className="text-xl font-semibold">{m.settings_account_heading()}</h2>

        <AvatarSettings url={loaderData.avatarUrl} uploaded={loaderData.avatarUploaded} />
        <section id="settings-display-name" className="scroll-mt-4 space-y-3">
          {saved === "display-name" && <p role="status">{m.settings_saved()}</p>}
          {actionData?.intent === "display-name" && <p role="alert">{actionData.error === "invalid_display_name" ? m.display_name_invalid() : actionData.error === "rate_limited" ? m.error_rate_limited() : m.signing_failed()}</p>}
          <SignedForm signatureRequired={signPosts} method="post" className="space-y-3">
            <input type="hidden" name="intent" value="display-name" />
            <DisplayNameFields key={JSON.stringify([homeArea, displayNames.displayName, displayNames.displayNameLatin])} homeArea={homeArea} initial={displayNames} />
            <Button type="submit" variant="outline">{m.save_changes()}</Button>
          </SignedForm>
        </section>
        <section id="settings-handle" aria-labelledby="settings-handle-heading" className="scroll-mt-4 space-y-3">
          <h3 id="settings-handle-heading" className="text-lg font-semibold">{m.settings_handle_heading()}</h3>
          {saved === "handle" && <p role="status">{m.settings_saved()}</p>}
          {actionData?.intent === "handle" && <p role="alert">{actionData.error === "handle_taken" ? m.onboarding_error_taken() : actionData.error === "handle_reserved" ? m.onboarding_error_reserved() : actionData.error === "too_soon" ? m.settings_handle_too_soon({ date: actionData.date! }) : actionData.error === "invalid_handle" ? m.onboarding_error_handle() : m.signing_failed()}</p>}
          {nextHandleChange && <p>{m.settings_handle_too_soon({ date: nextHandleChange })}</p>}
          <details open={handleOpen} className="space-y-2">
            {/* The name itself is the control that opens the form; the heading says what the form does. */}
            <summary className="cursor-pointer">@{handle}</summary>
            <p className="ui-help text-muted-foreground">{m.settings_handle_help()}</p>
            <SignedForm signatureRequired={signPosts} method="post" action={withSettingsReturn("/settings#settings-handle", returnTo)} className="space-y-2">
              <input type="hidden" name="intent" value="handle" />
              <Field className="min-w-0 w-auto"><FieldLabel className="block">{m.onboarding_handle()}<HandleInput key={handle} name="handle" required inputMode="text" minLength={2} maxLength={30} defaultValue={actionData && "handleValue" in actionData ? actionData.handleValue : handle} className="block" /></FieldLabel></Field>
              <FieldDescription className="ui-help text-muted-foreground">{m.onboarding_handle_help()}</FieldDescription>
              <Button type="submit" variant="outline">{m.settings_handle_heading()}</Button>
            </SignedForm>
          </details>
        </section>

        {actionData?.intent === "delete-passkey" && <p role="alert" className="text-destructive">{m.signing_failed()}</p>}
        <PasskeySettings passkeys={passkeys} fresh={loaderData.credentialFresh} saved={saved === "passkey-removed" ? saved : null} returnTo={returnTo} />

        <section id="settings-sessions" aria-labelledby="settings-sessions-heading" className="scroll-mt-4 space-y-3">
          <h3 id="settings-sessions-heading" className="text-lg font-semibold">{m.settings_sessions_heading()}</h3>
          <p>{m.settings_sessions_help()}</p>
          <p className="ui-help text-muted-foreground">{m.settings_links_sessions_help()}</p>
          {saved === "sessions" && <Alert role="status"><AlertDescription><span>{m.settings_sessions_revoked()}</span></AlertDescription></Alert>}
          <Form method="post" action={withSettingsReturn("/settings#settings-sessions", returnTo)}><input type="hidden" name="intent" value="revoke-other-sessions" /><Button type="submit" variant="outline" className="h-auto max-w-full whitespace-normal">{m.settings_sessions_revoke()}</Button></Form>
        </section>
      </section>

      {/* What is yours on the site, and where to see, change or take it: one list instead of scattered links. */}
      <section id="settings-records" aria-labelledby="settings-records-heading" className="scroll-mt-4 space-y-3">
        <h2 id="settings-records-heading" className="text-xl font-semibold">{m.settings_records_heading()}</h2>
        <ul className="space-y-1">
          <li><Link to={`/u/${handle}`} className="underline">{m.settings_records_page()}</Link></li>
          <li><Link to="/settings/stances" className="underline">{m.settings_stances_link()}</Link></li>
          <li><Link to="/settings/media" className="underline">{m.settings_media_title()}</Link></li>
          {"chatOwn" in loaderData && <li><Link to="/settings/chat" className="underline">{m.village_chat_own_title()}</Link></li>}
          <li><a href="/settings/export" download className="underline">{m.settings_export_link()}</a></li>
        </ul>
        <details id="settings-export" className="scroll-mt-4 ui-help text-muted-foreground">
          <summary className="cursor-pointer ui-meta">{m.settings_export_more_label()}</summary>
          <p className="mt-2">{"chatOwn" in loaderData ? m.settings_export_chat_help() : m.settings_export_help()}</p>
        </details>
      </section>

      <PersistentDetails id="settings-advanced" ref={advanced} open={saved === "sign-posts" || actionData?.intent === "sign-posts"} className="scroll-mt-4 space-y-6">
        <summary className="cursor-pointer text-xl font-semibold"><h2 className="inline">{m.settings_advanced_heading()}</h2></summary>
        <section id="settings-signing" aria-labelledby="settings-signing-heading" className="scroll-mt-4 space-y-3">
          <h3 id="settings-signing-heading" className="text-lg font-semibold">{m.settings_sign_posts_label()}</h3>
          {saved === "sign-posts" && <p role="status">{m.settings_saved()}</p>}
          {actionData?.intent === "sign-posts" && <p role="alert" className="text-destructive">{m.signing_failed()}</p>}
          <SignedForm signatureRequired method="post" action={withSettingsReturn("/settings#settings-signing", returnTo)} className="space-y-2" key={String(signPosts)}>
            <input type="hidden" name="intent" value="sign-posts" />
            <Field orientation="horizontal" className="min-w-0 w-auto"><FieldLabel className="flex items-center gap-2">
              <Checkbox name="signPosts" value="1" defaultChecked={signPosts} disabled={passkeys.length === 0} /> {m.settings_sign_posts_label()}
            </FieldLabel></Field>
            <FieldDescription className="ui-help text-muted-foreground">{m.settings_sign_posts_help()}</FieldDescription>
            <FieldDescription className="ui-help text-muted-foreground">{m.settings_sign_posts_limits()}</FieldDescription>
            {passkeys.length === 0 && <p>{m.settings_sign_posts_need_passkey()}</p>}
            <Button type="submit" disabled={passkeys.length === 0} variant="outline">{m.save_changes()}</Button>
          </SignedForm>
        </section>

        <section id="settings-tokens" aria-labelledby="settings-tokens-heading" className="scroll-mt-4 space-y-3">
          <h3 id="settings-tokens-heading" className="text-lg font-semibold">{m.settings_automation_heading()}</h3>
          <p className="ui-help text-muted-foreground">{m.settings_automation_help()}</p>
          <p><Link to="/settings/tokens" className="underline">{m.settings_tokens_link()}</Link></p>
        </section>

        <InstallGuideSettings />

        <section id="settings-share" aria-labelledby="settings-share-heading" className="scroll-mt-4 space-y-3">
          <h3 id="settings-share-heading" className="text-lg font-semibold">{m.settings_share_heading()}</h3>
          <p className="ui-help text-muted-foreground">{m.settings_share_bookmarklet()}</p>
          <div className="flex flex-wrap items-center gap-2">
            <CopyTextButton text={loaderData.shareBookmarklet} label={m.settings_share_copy()} copiedLabel={m.settings_share_copied()} />
          </div>
          <details className="ui-help text-muted-foreground">
            <summary className="cursor-pointer ui-meta">{m.settings_share_show()}</summary>
            <Textarea aria-labelledby="settings-share-heading" readOnly spellCheck={false} rows={4} value={loaderData.shareBookmarklet} className="mt-2 block w-full text-sm" />
          </details>
        </section>
      </PersistentDetails>
      <p className="ui-meta"><Link to="/settings/delete-account" className="underline">{m.account_delete_title()}</Link></p>
    </main>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
