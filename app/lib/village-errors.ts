import { m } from "~/paraglide/messages.js";
import { VILLAGE_INVITE_DAILY_LIMIT } from "~/lib/villages";

export function villageError(error: string): string {
  switch (error) {
    case "rate_limited": return m.error_rate_limited();
    case "slug_taken": return m.village_error_slug_taken();
    case "limit": return m.village_error_limit();
    case "paused":
    case "invite_wait": return m.village_error_paused();
    case "invite_limit": return m.village_error_invite_limit({ count: VILLAGE_INVITE_DAILY_LIMIT });
    case "pending": return m.village_error_pending();
    case "last_owner": return m.village_error_last_owner();
    case "forbidden": return m.village_error_forbidden();
    case "not_found": return m.village_error_unavailable();
    default: return m.village_error_invalid();
  }
}
