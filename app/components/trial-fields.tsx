import { Link } from "react-router";
import { Field, FieldLabel, FieldDescription } from "~/components/ui/field";
import { useOperatorSettings } from "~/lib/operator-context";
import { formatOperatorCopy, operatorCopy, participationCopy, type PublicOperatorSettings } from "~/lib/operator-settings";
import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";

export function trialErrorMessage(error: string, settings: PublicOperatorSettings): string | null {
  const policy = settings.participation;
  const copy = operatorCopy(settings, getLocale());
  switch (error) {
    case "invalid_country": return m.onboarding_error_country();
    case "country_excluded": return participationCopy(policy, getLocale()).countryExcluded;
    case "adult_required": return copy.adultError === null ? m.onboarding_error_adult({ age: policy.minimumAge }) : formatOperatorCopy(copy.adultError, { age: policy.minimumAge });
    case "trial_consent_required": return copy.agreementError ?? m.onboarding_error_consent();
    default: return null;
  }
}
export function TrialFields({ countries, country, adult, notices }: { countries: Array<{ code: string; label: string }>; country?: string | null; adult?: boolean; notices: { privacy: boolean; terms: boolean } }) {
  const settings = useOperatorSettings();
  const policy = settings.participation;
  const copy = operatorCopy(settings, getLocale());
  return <>
    <Field><FieldLabel htmlFor="residence-country">{m.onboarding_country()}</FieldLabel>
      <select id="residence-country" name="residenceCountry" required defaultValue={country ?? ""} aria-describedby="country-help" className="block w-full rounded border bg-background p-2">
        <option value="" disabled>{m.onboarding_country_placeholder()}</option>
        {countries.map(option => <option value={option.code} key={option.code}>{option.label}</option>)}
      </select>
      <FieldDescription id="country-help">{copy.countryHelp ?? m.onboarding_country_help()}</FieldDescription>
    </Field>
    {policy.minimumAge > 0 && <Field orientation="horizontal"><FieldLabel><input type="checkbox" name="adult" value="1" required defaultChecked={adult} className="size-4 shrink-0 accent-primary" />{m.onboarding_adult({ age: policy.minimumAge })}</FieldLabel></Field>}
    <input type="hidden" name="trialVersion" value={policy.trialConsentVersion} />
    <div className="space-y-2">
      {notices.terms && notices.privacy && <ul className="list-disc space-y-2 pl-5 ui-meta">
        <li>{participationCopy(policy, getLocale()).eligibilitySummary}</li>
        <li>{m.trial_summary_copyright({ trainingPolicy: copy.trainingPolicy })}</li>
        <li>{m.trial_summary_translation()}</li>
      </ul>}
      <p className="flex flex-wrap gap-x-3 ui-meta">
        {(notices.terms || notices.privacy) && <span>{m.trial_read_full()}</span>}
        {notices.terms && <Link to="/terms" className="underline">{copy.termsLabel ?? m.notice_terms()}</Link>}
        {notices.privacy && <Link to="/privacy" className="underline">{m.notice_privacy()}</Link>}
      </p>
      {policy.requireTrialConsent && <Field orientation="horizontal"><FieldLabel><input type="checkbox" name="trialAgree" value="1" required className="size-4 shrink-0 accent-primary" />{copy.agreementLabel ?? m.onboarding_trial_agree()}</FieldLabel></Field>}
    </div>
  </>;
}
