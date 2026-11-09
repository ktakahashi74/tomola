// Controls reasoning effort for translation through GEMINI_TRANSLATION_THINKING.
// off tries the lowest supported level, low requests LOW, and default omits the setting.
// Unsupported levels fall back through THINKING_LADDER in geminiComplete.
// Verify the selected model's behavior and usage records before production use.

export const THINKING_SETTINGS = ["off", "low", "default"] as const;
export type ThinkingSetting = (typeof THINKING_SETTINGS)[number];

export const DEFAULT_TRANSLATION_THINKING: ThinkingSetting = "off";

export type ThinkingLevelName = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

// The levels to try for a setting, in order. null: send no thinkingConfig (the model's default). The last rung is the one that cannot be rejected for being a
// thinking level.
export const THINKING_LADDER: Record<ThinkingSetting, ReadonlyArray<ThinkingLevelName | null>> = {
  off: ["MINIMAL", "LOW", null],
  low: ["LOW", null],
  default: [null],
};

export const THINKING_ENV = "GEMINI_TRANSLATION_THINKING";
export const CHAT_THINKING_ENV = "CHAT_TRANSLATION_THINKING";

// The setting of the Gemini divergence judge (DIVERGENCE_JUDGE_THINKING, same values, default off).
export const JUDGE_THINKING_ENV = "DIVERGENCE_JUDGE_THINKING";

// Extra output-token allowance for reasoning. The final total is capped at the model maximum.
export const THINKING_HEADROOM: Record<ThinkingLevelName | "default", number> = { MINIMAL: 2_048, LOW: 4_096, MEDIUM: 16_384, HIGH: 16_384, default: 16_384 };

export function thinkingHeadroom(level: ThinkingLevelName | null): number {
  return THINKING_HEADROOM[level ?? "default"];
}

// A level that the API rejected for a model is asked for again after this long (the model may have changed, or the rejection may have been about something else).
export const THINKING_REPROBE_AFTER_MS = 60 * 60 * 1000;
