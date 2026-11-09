import { m } from "~/paraglide/messages.js";

// Where the person is on the way in: email, code, name and language. It only shows the position; it does not count or reward.
export function EntrySteps({ current }: { current: 1 | 2 | 3 }) {
  const steps = [m.entry_step_mail(), m.entry_step_code(), m.entry_step_profile()];
  return <ol aria-label={m.entry_steps_label()} className="flex flex-wrap gap-x-4 gap-y-1 ui-meta text-muted-foreground">
    {steps.map((label, index) => <li key={index} aria-current={current === index + 1 ? "step" : undefined} className={current === index + 1 ? "font-semibold text-foreground" : undefined}>{index + 1} {label}</li>)}
  </ol>;
}
