import type { AiAssistance } from "~/lib/ai-assistance";
import { m } from "~/paraglide/messages.js";

// The name of an ai_assistance value. Used only by the operator screens (metrics and observation); no posting screen or post shows the value.
export function aiLabel(level: AiAssistance): string {
  if (level === "polish") return m.ai_polish();
  if (level === "draft") return m.ai_draft();
  if (level === "coauthor") return m.ai_coauthor();
  return m.ai_none();
}
