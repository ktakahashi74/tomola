import { m } from "~/paraglide/messages.js";

// Convert post-save errors into interface messages, shared by topic-new and topic.
export function entryErrorMessage(error: string): string {
  if (error === "village_required") return m.village_required();
  if (error === "village_changed") return m.village_changed();
  if (error === "invalid_intro") return m.intro_error_invalid();
  if (error === "invalid_title") return m.error_title();
  if (error === "invalid_lang") return m.error_invalid_lang();
  if (error === "body_required") return m.error_body();
  if (error === "body_too_long") return m.error_body_too_long();
  if (error === "body_too_complex") return m.error_body_too_complex();
  if (error === "body_unrenderable") return m.error_body_unrenderable();
  if (error === "frontmatter_invalid") return m.error_frontmatter();
  if (error === "frontmatter_type_mismatch") return m.error_frontmatter_type();
  if (error === "parent_not_in_thread") return m.error_reply_to_thread();
  if (error === "invalid_asks_stance") return m.error_invalid_asks_stance();
  if (error === "invalid_alt_of") return m.error_invalid_alt_of();
  if (error === "invalid_stance_tag") return m.error_invalid_stance_tag();
  // An edit attempted to change the title or body of a question locked by a recorded stance.
  if (error === "locked") return m.edit_locked_notice();
  // The draft this screen made for an AI was changed after it was saved (by the AI, or on another screen): it is kept, and this text is not saved over it.
  if (error === "draft_conflict") return m.ai_write_changed();
  if (error === "rate_limited") return m.error_rate_limited();
  // The Markdown worker was busy: the member did nothing wrong, and what was written is still in the form.
  if (error === "busy") return m.error_busy();
  if (["approval_changed", "published_content_changed", "published_target_changed"].includes(error)) return m.signing_changed();
  if (["signature_required", "signature_not_required", "invalid_signature", "wrong_passkey", "user_verification_required", "challenge_used_or_unknown", "challenge_expired", "passkey_required", "invalid_view", "invalid_payload"].includes(error)) return m.signing_failed();
  return m.error_generic();
}
