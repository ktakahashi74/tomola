import { m } from "~/paraglide/messages.js";

// Describe the appealed action with the same wording for the member and the reviewer (the appeal and review screens).
export function appealActionText(action: "clear_village_icon" | "clear_avatar" | "clear_display_name" | "hide" | "delete" | "suspend" | "exclude_reactions" | "fix_entry" | "fix_village" | "end_village" | "hide_chat", until: string | null): string {
  switch (action) {
    case "clear_village_icon": return m.log_village_icon_removed();
    case "clear_avatar": return m.log_avatar_removed();
    case "clear_display_name": return m.notification_display_name_removed();
    case "hide_chat": return m.notification_moderation_hide_chat();
    case "suspend":
      return m.appeal_action_suspend({ until: until ?? "" });
    case "delete":
      return m.appeal_action_delete();
    case "exclude_reactions":
      return m.appeal_action_exclude();
    case "fix_village":
      return m.notification_moderation_fix_village();
    case "end_village":
      return m.notification_moderation_end_village();
    case "fix_entry":
      return m.appeal_action_fix();
    default:
      return m.appeal_action_hide();
  }
}
