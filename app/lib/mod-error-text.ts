import type { VillageModerationError } from "~/lib/village-moderation.server";
import { m } from "~/paraglide/messages.js";

export type ModError = VillageModerationError | "confirm_required";

export function errorText(error: ModError): string {
  switch (error) {
    case "stale":
      return m.village_mod_stale();
    case "invalid_village":
      return m.village_error_invalid();
    case "slug_taken":
      return m.village_error_slug_taken();
    case "forbidden":
      return m.mod_error_forbidden();
    case "own_entry":
      return m.mod_error_own();
    case "invalid_state":
      return m.mod_error_state();
    case "note_required":
      return m.mod_error_note_required();
    case "invalid_note":
      return m.mod_error_note();
    case "invalid_reason":
      return m.mod_error_reason();
    case "confirm_required":
      return m.mod_error_confirm();
    case "invalid_days":
      return m.mod_error_days();
    case "target_is_operator":
      return m.mod_error_operator();
    default:
      return m.mod_error_not_found();
  }
}
