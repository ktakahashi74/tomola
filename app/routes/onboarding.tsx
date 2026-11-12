import { useOperatorSettings } from "~/lib/operator-context";
import { operatorCopy, type PublicOperatorSettings } from "~/lib/operator-settings";
import { TrialFields, trialErrorMessage } from "~/components/trial-fields";
import { countryOptions, type TrialInput } from "~/lib/trial-consent";
import { saveTrialConsent, isExcludedCountry, needsTrialConsent } from "~/lib/trial-consent.server";
import { noticesAvailable, trialParticipationRequired } from "~/lib/notices.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Button } from "~/components/ui/button";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "~/components/ui/field";
import { HandleInput } from "~/components/handle-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { useCallback, useEffect, useRef, useState } from "react";
import { Form, Link, redirect, redirectDocument, useLocation } from "react-router";
import type { Route } from "./+types/onboarding";
import { GuestHeader } from "~/components/guest-header";
import { EntrySteps } from "~/components/entry-steps";
import { welcomeCookie } from "~/lib/auth/welcome.server";
import { isPrinciplesLang, principlesOpening } from "~/lib/principles.server";
import { getSessionProfile, requireUser } from "~/lib/auth/session.server";
import { clearReadingReturn, readReadingReturn } from "~/lib/auth/reading-return.server";
import { publicReading } from "~/lib/public-reading.server";
import { getDb } from "~/lib/db/client.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { defaultMainLang, uiLocaleCookie } from "~/lib/http/locale.server";
import { isLang, LANG_LABELS, type Lang } from "~/lib/languages";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { createProfile, getProfile } from "~/lib/profiles.server";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { clearInvitationCookie } from "~/lib/auth/invitation-cookie.server";
import { consumedInvitationVillage, joinedSignupVillage } from "~/lib/signup-village.server";

// Signup records the handle and the main language, the country of residence, adulthood and explicit agreement to the trial terms. The screen groups them under "about you" and "before you join"; the second group is where
// the disclosures and the consent are read. A member whose profile exists but whose consent is missing or outdated sees only the second group. The default of the main language is the language the browser prefers most if it is enabled,
// otherwise "other". The read languages start as the main language only and can be extended in the settings. There are no "writable languages".
async function loaderImplementation({ request }: Route.LoaderArgs) {
  const next = safeLocalPath(new URL(request.url).searchParams.get("next"));
  const user = await requireUser(request);
  const db = await getDb();
  const profile = await getSessionProfile(request);
  const trialRequired = trialParticipationRequired();
  if (profile && (!trialRequired || (!needsTrialConsent(profile) && !isExcludedCountry(profile.residenceCountry)))) {
    const headers = new Headers();
    clearReadingReturn(request, headers);
    const joined = next === "/" ? await joinedSignupVillage(db, user.id) : null;
    throw redirect(joined ? `/v/${joined.slug}` : next, { headers });
  }
  const enabled = enabledLangs();
  // For each language the person can pick, the first sentence of the principles in that language: choosing a language shows what it buys.
  const opening = Object.fromEntries(enabled.filter(isPrinciplesLang).map(lang => [lang, principlesOpening(lang)]));
  return {
    draftOwner: user.id,
    village: await consumedInvitationVillage(db, user.id),
    defaultMainLang: defaultMainLang(request.headers.get("accept-language"), enabled), publicReading: publicReading(), opening,
    trialRequired, ownHandle: profile?.handle ?? null, existing: !!profile, country: profile?.residenceCountry ?? null, adult: !!profile?.adultConfirmedAt,
    excluded: trialRequired && isExcludedCountry(profile?.residenceCountry), countries: trialRequired ? countryOptions(getLocale()) : [], notices: noticesAvailable(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const next = safeLocalPath(new URL(request.url).searchParams.get("next"));
  let destination = next === "/" ? readReadingReturn(request) ?? "/" : next;
  // A new member gets a one-time greeting (the layout reads the cookie); a repeated submission of an existing profile does not.
  const completed = async (greet = false, locale?: Lang) => {
    if (destination === "/") {
      const joined = await joinedSignupVillage(db, user.id);
      if (joined) destination = `/v/${joined.slug}`;
    }
    const headers = new Headers();
    if (locale) headers.append("Set-Cookie", uiLocaleCookie(request, locale));
    clearReadingReturn(request, headers);
    clearInvitationCookie(request, headers);
    if (greet) headers.append("Set-Cookie", welcomeCookie(request, destination.startsWith("/t/") ? "article" : "home"));
    // A different locale must replace the client's existing Paraglide state too.
    return (locale && locale !== getLocale() ? redirectDocument : redirect)(destination, { headers });
  };
  const user = await requireUser(request);
  const db = await getDb();
  // Duplicate submissions retain the same validated return destination.
  const profile = await getSessionProfile(request);
  const trialRequired = trialParticipationRequired();
  if (profile && (!trialRequired || (!needsTrialConsent(profile) && !isExcludedCountry(profile.residenceCountry)))) throw await completed();
  const form = await request.formData();
  const trial: TrialInput = { residenceCountry: String(form.get("residenceCountry") ?? ""), adult: form.get("adult") === "1", agree: form.get("trialAgree") === "1", version: Number(form.get("trialVersion")) };
  if (profile) {
    const result = await saveTrialConsent(db, user.id, trial);
    if (result.ok) throw await completed();
    return { error: result.error };
  }
  let res: Awaited<ReturnType<typeof createProfile>>;
  const mainLang = String(form.get("homeArea") ?? "");
  const signupLocale = isLang(mainLang) && enabledLangs().includes(mainLang) ? mainLang : getLocale();
  try {
    res = await createProfile(
      db,
      user.id,
      {
        handle: String(form.get("handle") ?? ""),
        homeArea: mainLang,
      },
      // For "other" the default read language is the language of this screen (an enabled language).
      { uiLocale: signupLocale, ...(trialRequired ? { trial } : {}) },
    );
  } catch (error) {
    // Treat a primary-key conflict from simultaneous submissions as an already-created profile.
    if (await getProfile(db, user.id)) throw await completed();
    throw error;
  }
  if (res.ok) throw await completed(true, signupLocale);
  // Duplicate-submission race: if the earlier request created the same handle, the later one gets handle_taken. Do not show an error when the profile already exists.
  if (res.error === "handle_taken" && (await getProfile(db, user.id))) throw await completed();
  return { error: res.error };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.onboarding_welcome() }];
}

function onboardingErrorMessage(error: string, settings: PublicOperatorSettings): string {
  const trial = trialErrorMessage(error, settings);
  if (trial) return trial;
  if (error === "invalid_handle") return m.onboarding_error_handle();
  if (error === "handle_taken") return m.onboarding_error_taken();
  if (error === "handle_reserved") return m.onboarding_error_reserved();
  if (error === "invalid_area") return m.onboarding_error_area();
  return m.error_generic();
}

// Says, as the name is typed, whether it has the right shape, and that capitals become lowercase. Whether the name is taken is known only when the form is sent.
const HANDLE_SHAPE = /^[a-z0-9][a-z0-9_-]{1,29}$/;
function HandleHint() {
  const ref = useRef<HTMLParagraphElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    const input = ref.current?.closest("form")?.querySelector<HTMLInputElement>('input[name="handle"]');
    if (!input) return;
    const read = () => setValue(input.value);
    read();
    input.addEventListener("input", read);
    return () => input.removeEventListener("input", read);
  }, []);
  // The same steps as the server: trim, NFKC, lowercase (so full-width letters and stray spaces are judged as they will be saved).
  const lower = value.trim().normalize("NFKC").toLowerCase();
  return <p ref={ref} id="onboarding-handle-hint" className="ui-help text-muted-foreground">
    {value === "" ? m.onboarding_handle_hint() : HANDLE_SHAPE.test(lower) ? m.onboarding_handle_ok({ handle: lower }) : m.onboarding_error_handle()}
  </p>;
}

export default function Onboarding({ loaderData, actionData }: Route.ComponentProps) {
  const settings = useOperatorSettings();
  const policy = settings.participation;
  const copy = operatorCopy(settings, getLocale());
  const errorMessage = (error: string) => onboardingErrorMessage(error, settings);
  const langs = useEnabledLangs();
  const location = useLocation();
  const formRef = useRef<HTMLFormElement>(null);
  const [area, setArea] = useState<string>(loaderData.defaultMainLang);
  // Keep this tab's history entry, including unchecked boxes. Bind it to the
  // signed-in person and current terms; nothing is sent to the server or other tabs.
  const remember = useCallback((homeArea = area) => {
    if (!formRef.current) return;
    const fields = new FormData(formRef.current);
    window.history.replaceState({ ...window.history.state, onboarding: {
      owner: loaderData.draftOwner, version: policy.trialConsentVersion, homeArea,
      handle: String(fields.get("handle") ?? ""), country: String(fields.get("residenceCountry") ?? ""),
      adult: fields.has("adult"), agree: fields.has("trialAgree"),
    } }, "");
  }, [area, loaderData.draftOwner, policy.trialConsentVersion]);
  function clearDraft() {
    const state = { ...window.history.state };
    delete state.onboarding;
    window.history.replaceState(state, "");
  }
  useEffect(() => {
    const saved = window.history.state?.onboarding;
    const form = formRef.current;
    if (!form) return;
    if (!saved) { remember(); return; }
    if (saved.owner !== loaderData.draftOwner || saved.version !== policy.trialConsentVersion) return;
    for (const [name, value] of [["handle", saved.handle], ["residenceCountry", saved.country]] as const) {
      const input = form.elements.namedItem(name);
      if ((input instanceof HTMLInputElement || input instanceof HTMLSelectElement) && typeof value === "string") input.value = value;
    }
    for (const [name, value] of [["adult", saved.adult], ["trialAgree", saved.agree]] as const) {
      const input = form.elements.namedItem(name);
      if (input instanceof HTMLInputElement) input.checked = value === true;
    }
    if (saved.homeArea === "other" || langs.includes(saved.homeArea)) setArea(saved.homeArea);
    form.querySelector('input[name="handle"]')?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [loaderData.draftOwner, location.key, langs, actionData, remember, policy.trialConsentVersion]);
  const readingExit = loaderData.publicReading && !loaderData.existing;
  const echo = loaderData.opening[area];
  return (
    <>
    <GuestHeader>
        <Form method="post" action="/logout" onSubmit={clearDraft}>
          <Button type="submit" className="text-sm" variant="link">
            {m.nav_logout()}
          </Button>
        </Form>
    </GuestHeader>
    <main className="space-y-4">
      {!loaderData.existing && <EntrySteps current={3} />}
      <h1 className="text-2xl font-bold">{loaderData.existing ? (copy.reviewTitle ?? m.onboarding_review_title()) : m.onboarding_welcome()}</h1>
      {loaderData.existing && <p>{copy.reviewHelp ?? m.onboarding_review_help()}</p>}
      {loaderData.village && <p className="break-words">{m.invite_village({ village: loaderData.village.name })}</p>}
      {loaderData.existing && <nav className="flex flex-wrap gap-3 ui-meta">
        <Link to="/settings" className="underline">{m.nav_settings()}</Link>
        <Link to="/notifications" className="underline">{m.nav_notifications()}</Link>
        <Link to={`/u/${loaderData.ownHandle}`} className="underline">{m.nav_my_page()}</Link>
      </nav>}
      <Form ref={formRef} method="post" className="space-y-6" onChange={() => remember()} onSubmit={clearDraft}>
        {!loaderData.existing && <FieldSet>
          <FieldLegend>{m.onboarding_group_you()}</FieldLegend>
        <Field className="min-w-0 w-auto"><FieldLabel className="block">
          {m.onboarding_handle()}
          <HandleInput aria-invalid={!!actionData?.error && actionData.error !== "invalid_area" || undefined} aria-describedby={`onboarding-handle-hint${actionData?.error && actionData.error !== "invalid_area" ? " onboarding-error" : ""}`} name="handle" required inputMode="text" className="block w-full" />
        </FieldLabel></Field>
        <HandleHint />
        <Field className="min-w-0 w-auto"><FieldLabel className="block">
          {m.onboarding_home_area()}
          <Select name="homeArea" required value={area} onValueChange={value => { if (value !== null) { setArea(value); remember(value); } }} items={[...langs.map((l) => (
              { value: l, label: LANG_LABELS[l] }
            )), { value: "other", label: m.area_other() }]}>
              <SelectTrigger className="w-full min-w-0" aria-label={m.onboarding_home_area()} aria-invalid={actionData?.error === "invalid_area" || undefined} aria-describedby={`onboarding-language-help${actionData?.error === "invalid_area" ? " onboarding-error" : ""}`}><SelectValue /></SelectTrigger>
              <SelectContent>
            {langs.map((l) => (
              <SelectItem key={l} value={l} lang={l}>
                {LANG_LABELS[l]}
              </SelectItem>
            ))}
            <SelectItem value="other">{m.area_other()}</SelectItem>
          </SelectContent>
            </Select>
        </FieldLabel></Field>
        <FieldDescription id="onboarding-language-help" className="ui-help text-muted-foreground">{m.onboarding_language_help()}</FieldDescription>
        {area === "other" && <p className="ui-help"><Link to="/languages" className="underline">{m.languages_signup()}</Link></p>}
        {echo && <p lang={area} className="ui-help text-muted-foreground" data-testid="onboarding-language-echo">{echo.text}{echo.ai ? <span lang={getLocale()}> {m.onboarding_echo_ai()}</span> : null}</p>}
        <details className="space-y-2 ui-help text-muted-foreground">
          <summary className="cursor-pointer ui-meta">{m.onboarding_language_details()}</summary>
          <p>{m.onboarding_home_area_help()}</p>
        </details>
        </FieldSet>}
        {/* Explain data use and the operator's stance-access policy separately from consent. */}
        <FieldSet>
          <FieldLegend>{m.onboarding_group_before()}</FieldLegend>
        <div className="space-y-1 ui-help text-muted-foreground">
          {loaderData.publicReading && <p>{m.public_reading_onboarding()}</p>}
          <p>{m.onboarding_purposes({ aiRecipient: copy.aiRecipient })}</p>
          {loaderData.notices.privacy && <p><Link to="/privacy" className="underline">{m.onboarding_privacy_details()}</Link></p>}
        </div>
        {loaderData.trialRequired && <TrialFields countries={loaderData.countries} country={loaderData.country} adult={loaderData.adult} notices={loaderData.notices} />}
        <div className="space-y-1 ui-help text-muted-foreground">
          <p>{copy.stanceDisclosure}</p>
          <p>{m.disclosure_member_page()}</p>
        </div>
        </FieldSet>
        {(actionData?.error || loaderData.excluded) && <div id="onboarding-error" role="alert" className="space-y-2 text-destructive">
          <p>{errorMessage(actionData?.error ?? "country_excluded")}</p>
          {(actionData?.error === "country_excluded" || loaderData.excluded) && <>
            {loaderData.existing && <p><Link to="/" className="underline">{m.onboarding_read_only()}</Link></p>}
            {readingExit && <Button type="submit" form="onboarding-leave" variant="link">{m.onboarding_leave()}</Button>}
          </>}
        </div>}
        <Button type="submit">
          {loaderData.existing ? m.save_changes() : m.onboarding_join()}
        </Button>
      </Form>
      {readingExit && <Form id="onboarding-leave" method="post" action="/logout" onSubmit={clearDraft}>
        <Button type="submit" variant="link">{m.onboarding_leave()}</Button>
      </Form>}
    </main>
    </>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
