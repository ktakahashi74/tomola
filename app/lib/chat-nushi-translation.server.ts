import type { Db } from "./db/client.server";
import type { chatMessages } from "./db/schema";
import type { Lang } from "./languages";
import { resolveEngines } from "./llm/config.server";
import { translateChecked } from "./llm/translate.server";
import { meteredCall, translationEstimate } from "./llm/metering.server";
import { CHAT_NUSHI_PROMPT_VERSION } from "./chat-nushi-config.server";
import { m } from "~/paraglide/messages.js";

// Only the generated readings are translated. Quotations, attribution, dates,
// scope and destinations remain byte-for-byte from the checked chat answer.
export async function translateChatNushi(db: Db, message: typeof chatMessages.$inferSelect, language: Lang, options: { clock: () => Date; signal?: AbortSignal }) {
  const shape = message.nushiShape;
  if (!shape) throw new Error("Missing village chat AI answer structure");
  if (shape.status === "not_confirmed") {
    // Older answers predate the saved flag; inspect their original-language copy.
    const clarificationNeeded = typeof shape.clarificationNeeded === "boolean" ? shape.clarificationNeeded
      : message.body.includes(m.chat_nushi_clarify({}, { locale: message.lang as Lang }));
    const askPerson = typeof shape.askPerson === "boolean" ? shape.askPerson
      : message.body.includes(m.nushi_ask_person({}, { locale: message.lang as Lang }));
    return { text: [m.nushi_not_found({}, { locale: language }), ...(askPerson ? [m.nushi_ask_person({}, { locale: language })] : []), ...(clarificationNeeded ? [m.chat_nushi_clarify({}, { locale: language })] : [])].join(" "), flags: [], model: "site-copy", promptVersion: CHAT_NUSHI_PROMPT_VERSION };
  }
  const engine = resolveEngines().primary;
  if (!engine) throw new Error("Village chat AI translation is unavailable");
  let text = message.body;
  for (const [from, to] of [...shape.ranges].reverse()) {
    const result = await translateChecked({ ...engine, async translate(req) {
      const { result } = await meteredCall(db, { engine: engine.id, model: engine.model, purpose: "ask_village", role: "ask", estimateMicro: translationEstimate(engine.id, engine.model, req), now: options.clock(), clock: options.clock, signal: options.signal },
        () => engine.translate({ ...req, signal: options.signal }), result => ({ inputTokens: result.inputTokens, outputTokens: result.outputTokens }));
      return result;
    } }, { text: message.body.slice(from, to), from: message.lang as Lang, to: language, signal: options.signal });
    if (result.flags.length || result.text.length > 2400) throw new Error("Village chat AI translation failed verification");
    text = text.slice(0, from) + result.text + text.slice(to);
  }
  return { text, flags: [], model: engine.model, promptVersion: CHAT_NUSHI_PROMPT_VERSION };
}
