// Shared constants, types, and attribute validation for questions asking for stances. Also used in the browser; no DB access.
// The CHECK constraints in schema.ts use these constants too (drizzle-kit loads them, so use relative imports only).

// Three stance choices counted without names.
export const POSITIONS = ["agree", "disagree", "neither"] as const;
export type Position = (typeof POSITIONS)[number];
// Reply tags: named stances and reasons (agree, disagree, neither), or an objection to the question's framing (objection). Do not match these against a member's choices counted without names.
export const STANCE_TAGS = [...POSITIONS, "objection"] as const;
export type StanceTag = (typeof STANCE_TAGS)[number];
export const isPosition = (x: unknown): x is Position => typeof x === "string" && (POSITIONS as readonly string[]).includes(x);
export const isStanceTag = (x: unknown): x is StanceTag => typeof x === "string" && (STANCE_TAGS as readonly string[]).includes(x);
// Number of reason slots per stance.
export const REASON_SLOTS = 3;
// Number of entries in each objection section (alternative framings and objection replies).
export const OBJECTION_PANEL_LIMIT = 5;

export type StanceAttrError = "invalid_asks_stance" | "invalid_alt_of" | "invalid_stance_tag";

export type StanceAttrInput = {
  kind: "topic" | "reply";
  // create: creation, including draft publication. draft: saving a draft (Web or API). edit: editing a published post.
  mode: "create" | "draft" | "edit";
  asksStance: boolean;
  altOf: number | null;
  stanceTag: StanceTag | null;
  // For a reply: whether its topic is a question.
  threadAsksStance?: boolean;
  // When altOf is set: the referenced post (null if missing).
  altTarget?: { kind: "topic" | "reply"; asksStance: boolean; deleted: boolean; hidden: boolean } | null;
  // For edits: current values (attributes cannot be added, removed, or changed later).
  current?: { asksStance: boolean; altOf: number | null };
};

// Validate the combination of `asks_stance`, `alt_of`, and `stance_tag` in one function shared by creation, drafts, and edits. No DB access: the caller reads the facts (whether the topic is a question, the target post's state,
// and current values) within the transaction and passes them in (loadStanceAttrFacts in app/lib/questions.server.ts).
// Check rules in order and return the first error. Restricting tags to question replies and alt_of to undeleted, unhidden questions requires reading other rows,
// so enforce those rules here rather than with DB CHECK constraints.
export function checkStanceAttributes(input: StanceAttrInput): StanceAttrError | null {
  // 1. A reply cannot be a question or an alternative framing.
  if (input.kind === "reply") {
    if (input.asksStance) return "invalid_asks_stance";
    if (input.altOf !== null) return "invalid_alt_of";
  }
  // 2. A topic cannot have a reply tag.
  if (input.kind === "topic" && input.stanceTag !== null) return "invalid_stance_tag";
  // 3. Question attributes cannot change during edits (no later addition or removal).
  if (input.mode === "edit") {
    const current = input.current ?? { asksStance: false, altOf: null };
    if (input.asksStance !== current.asksStance) return "invalid_asks_stance";
    if (input.altOf !== current.altOf) return "invalid_alt_of";
  }
  // 4. An alternative framing must be a question.
  if (input.altOf !== null && !input.asksStance) return "invalid_alt_of";
  // 5. On creation or draft save, the target must be an undeleted, unhidden question (skip this on edits: the target is fixed at creation).
  if (input.mode !== "edit" && input.altOf !== null) {
    const target = input.altTarget;
    if (!target || target.kind !== "topic" || !target.asksStance || target.deleted || target.hidden) return "invalid_alt_of";
  }
  // 6. Reply tags apply only to replies to questions.
  if (input.kind === "reply" && input.stanceTag !== null && input.threadAsksStance !== true) return "invalid_stance_tag";
  return null;
}
