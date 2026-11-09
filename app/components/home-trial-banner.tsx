import { m } from "~/paraglide/messages.js";

export function HomeTrialBanner() {
  return <aside aria-label={m.home_trial_heading()} className="mb-5 space-y-1 rounded border border-notice-border bg-notice-soft px-4 py-3 text-sm">
    <p className="font-semibold">{m.home_trial_heading()}</p>
    <p className="ui-help">{m.home_trial_notice()} <a href="/__test/" className="font-semibold underline">{m.home_trial_guide()}</a></p>
  </aside>;
}
