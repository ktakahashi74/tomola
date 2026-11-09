import { enabledLangs } from "./enabled-langs.server";
import { MAX_BODY_LENGTH } from "./entries.server";

export type DraftApiError =
  | "village_required"
  | "invalid_frontmatter"
  | "frontmatter_not_object"
  | "unknown_type"
  | "reply_to_malformed"
  | "reply_to_on_topic"
  | "reply_to_required"
  | "reply_to_not_found"
  | "thread_deleted"
  | "invalid_title"
  | "body_required"
  | "body_too_long"
  | "body_unrenderable"
  | "body_too_complex"
  | "invalid_lang"
  | "invalid_ai"
  | "invalid_asks_stance"
  | "invalid_alt_of"
  | "invalid_stance_tag"
  | "invalid_encoding";

const MESSAGES: Record<DraftApiError, string> = {
  village_required: "Choose your own village or an available village you have joined before posting a topic.",
  invalid_frontmatter: "The frontmatter could not be read as YAML (it must start with a --- line, end with a --- line and be valid YAML without anchors or duplicate keys).",
  frontmatter_not_object: "The frontmatter must be a YAML mapping (key: value lines).",
  unknown_type: "type must be topic or reply (post and comment are accepted too).",
  reply_to_malformed: "reply_to must be p-<id> (a topic) or c-<id> (a reply).",
  reply_to_on_topic: "reply_to is only for replies, but type is topic.",
  reply_to_required: "A reply needs reply_to (p-<id> or c-<id>).",
  reply_to_not_found: "The post named in reply_to does not exist.",
  thread_deleted: "The topic being replied to was deleted.",
  invalid_title: "The title is optional: when there is one, it is one line of at most 200 characters. A topic with asks_stance: true needs a title (the proposition).",
  body_required: "The body is empty.",
  body_too_long: `The body is longer than ${MAX_BODY_LENGTH} characters.`,
  body_too_complex: "This text has too much markup to process in time. Use less markup, or put runs of symbols inside a code block.",
  body_unrenderable: "The body cannot be displayed (for example, very deeply nested lists or quotes).",
  // lang must be one of the languages of this site (ENABLED_LANGS); the text is filled in when the message is built (messageOf).
  invalid_lang: "lang must be one of the languages of this site.",
  invalid_ai: "ai_assistance must be none, polish, draft or coauthor.",
  invalid_asks_stance: "asks_stance must be true or false and is only for topics.",
  invalid_alt_of: "alt_of must be p-<id> of a question that is neither deleted nor hidden, and needs asks_stance: true.",
  invalid_stance_tag: "stance_tag must be agree, disagree, neither or objection, and is only for replies to a question.",
  invalid_encoding: "The body must be valid UTF-8 without NUL (U+0000) characters.",
};

// invalid_lang names the languages that are enabled on this site (ENABLED_LANGS), not the nine the software supports.
export function messageOf(error: string): string {
  if (error === "thread_not_found" || error === "parent_not_in_thread") error = "reply_to_not_found";
  if (error === "invalid_draft") return "Provide a valid draft kind and body without NUL characters.";
  return error === "invalid_lang" ? `lang must be one of the languages of this site: ${enabledLangs().join(", ")}.` : MESSAGES[error as DraftApiError] ?? error;
}
