import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";

// Reason-category label in the requested mail language. UI uses app/components/reason-label.ts.
export function reasonLabelFor(reason: string, locale: Locale): string {
  const o = { locale };
  switch (reason) {
    case "spam":
      return m.reason_spam({}, o);
    case "harassment":
      return m.reason_harassment({}, o);
    case "infohazard":
      return m.reason_infohazard({}, o);
    default:
      return m.reason_other({}, o);
  }
}
