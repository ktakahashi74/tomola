// Report/action enums shared by UI/server and DB CHECK generation (app/lib/db/schema.ts).
// Adding values requires updating these enums and constraints together and a migration rebuilding constraints.
export const REPORT_REASONS = ["spam", "harassment", "infohazard", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
// restore is the appeal action restoring a deleted post, added to the specification's list.
// exclude_reactions removes stances/Insightful (「なるほど」) from counts, operator-only member action; include_reactions reverses it, including after successful appeals.
// fix_entry corrects typos on questions locked by a non-author stance, by scoped moderators/operators. unfix_entry restores the previous version after a successful appeal.
export const MODERATION_ACTIONS = ["hide", "unhide", "suspend", "unsuspend", "dismiss_report", "delete", "restore", "exclude_reactions", "include_reactions", "fix_entry", "unfix_entry", "fix_village", "end_village", "unfix_village", "reopen_village", "dismiss_village_report", "clear_village_icon", "restore_village_icon", "hide_chat", "unhide_chat", "dismiss_chat_report", "delete_media", "clear_display_name", "restore_display_name", "dismiss_display_name_report", "clear_avatar", "restore_avatar", "dismiss_avatar_report"] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
// Post actions require target_entry_id; member actions require target_user_id. Used to generate DB CHECK constraints too.
export const ENTRY_ACTIONS = ["hide", "unhide", "delete", "restore", "dismiss_report", "fix_entry", "unfix_entry"] as const;
export const MEMBER_ACTIONS = ["suspend", "unsuspend", "exclude_reactions", "include_reactions", "clear_display_name", "restore_display_name", "dismiss_display_name_report", "clear_avatar", "restore_avatar", "dismiss_avatar_report"] as const;

export const VILLAGE_ACTIONS = ["fix_village", "end_village", "unfix_village", "reopen_village", "dismiss_village_report", "clear_village_icon", "restore_village_icon"] as const;

export const CHAT_ACTIONS = ["hide_chat", "unhide_chat", "dismiss_chat_report"] as const;

export const isReason = (x: unknown): x is ReportReason => typeof x === "string" && (REPORT_REASONS as readonly string[]).includes(x);

// Appeal states: open awaits review, upheld supports the action, overturned reverses it.
export const APPEAL_STATUSES = ["open", "upheld", "overturned"] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];
// Appealable actions: the affected member may appeal each action once.
export const APPEALABLE_ACTIONS = ["hide", "delete", "suspend", "exclude_reactions", "fix_entry", "fix_village", "end_village", "hide_chat", "clear_display_name", "clear_avatar", "clear_village_icon"] as const;

// Maximum suspension days: moderators 30, only with scoped reports; operators 365. Expiry is always required.
export const MAX_SUSPEND_DAYS = { moderator: 30, operator: 365 } as const;
