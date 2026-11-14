import type { LlmEnv } from "./llm/types";
import { nushiInVillage } from "./nushi-config.server";
import { villageChatEnabled } from "./village-chat-enabled.server";

export const CHAT_NUSHI_PROMPT_VERSION = "chat-nushi-v1";
export const chatNushiEnabled = (env: LlmEnv = process.env) => env.VILLAGE_CHAT_NUSHI === "1";
export function chatNushiInVillage(village: Parameters<typeof nushiInVillage>[0], env: LlmEnv = process.env) {
  return chatNushiEnabled(env) && villageChatEnabled(env) && nushiInVillage(village, { ...env, VILLAGE_NUSHI: "1" });
}
export const CHAT_NUSHI_INTERVAL_MS = 10 * 60_000;
export const CHAT_NUSHI_INTERVAL_LIMIT = 3;
