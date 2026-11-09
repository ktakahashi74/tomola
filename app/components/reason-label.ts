import { m } from "~/paraglide/messages.js";

// Interface-language names for reason categories used by reports and moderation actions.
export function reasonLabel(reason: string): string {
  switch (reason) {
    case "spam":
      return m.reason_spam();
    case "harassment":
      return m.reason_harassment();
    case "infohazard":
      return m.reason_infohazard();
    default:
      return m.reason_other();
  }
}
