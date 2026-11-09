import type { EngineId, LlmEnv } from "./types";

// Prices are integer nanodollars per input/output token.
// Equivalent to USD per million tokens multiplied by 1000 ($0.10/million = 100; $5/million = 5000).
// Cost in microdollars: ceil((input tokens × input price + output tokens × output price) / 1000). Integer arithmetic avoids floating-point error.
export type Price = { inputNano: number; outputNano: number };

const usdPerMTok = (input: number, output: number): Price => ({
  inputNano: Math.round(input * 1000),
  outputNano: Math.round(output * 1000),
});

// USD per million tokens, input/output.
export const PRICE_TABLE: Record<string, Price> = {
  // Former light-model default; retained for historical usage and explicit overrides.
  "gemini-3.1-flash-lite": usdPerMTok(0.25, 1.5),
  // Shared light-model default.
  "gemini-3.5-flash-lite": usdPerMTok(0.3, 2.5),
  // Historical price for old usage records; current API calls to this model route to gemini-3.6-flash.
  "gemini-3.5-flash": usdPerMTok(1.5, 9),
  // $1.50/$7.50 input/output from 2027-01-01 (https://aistudio.google.com/docs/pricing, checked 2026-11-04); ignore the 2026 discount for conservative estimates.
  // Default model for explicitly enabled Gemini secondary and judge roles.
  "gemini-3.6-flash": usdPerMTok(1.5, 7.5),
  "gemini-3.8-flash": usdPerMTok(1.5, 7.5),
  "claude-haiku-4-5": usdPerMTok(1, 5),
  // Higher-tier Claude translation model for report retries/comparisons. Prices from claude-api documentation as of 2026-09-25, provisional until live verification.
  // Unlisted models use the provider's highest listed price, conservatively (see FALLBACK). Override changes with LLM_PRICE_<name>.
  "claude-sonnet-5-5": usdPerMTok(2, 10),
  "claude-sonnet-5": usdPerMTok(2, 10),
  "claude-sonnet-4-6": usdPerMTok(3, 15),
  "claude-opus-5-5": usdPerMTok(4, 20),
  "claude-opus-5": usdPerMTok(5, 25),
  "claude-opus-4-8": usdPerMTok(5, 25),
  "claude-opus-4-7": usdPerMTok(5, 25),
  "claude-fable-5-1": usdPerMTok(10, 50),
  "claude-fable-5": usdPerMTok(10, 50),
  "claude-mythos-5-1": usdPerMTok(10, 50),
  "claude-mythos-5": usdPerMTok(10, 50),
  // Embedding for semantic search, charged for input only.
  "gemini-embedding-001": usdPerMTok(0.15, 0),
  // Former default retained to estimate costs in existing deployments.
  "gemini-2.5-flash-lite": usdPerMTok(0.1, 0.4),
};

// Estimate unlisted models lacking LLM_PRICE_<name> using the provider's highest listed prices, identified by claude-/gemini- prefix or the called engine,
// maximizing input and output separately. Unknown models are not necessarily cheaper; avoid undercounting that weakens budget protection.
// Unknown provider uses the whole table's maxima. Adding a model also updates the estimate.
export function fallbackPriceFor(model: string, provider?: string): Price {
  const named = model.startsWith("claude-") ? "claude" : model.startsWith("gemini-") ? "gemini" : undefined;
  const wanted = provider === "claude" || provider === "gemini" ? provider : named;
  const entries = Object.entries(PRICE_TABLE).filter(([name]) => wanted === undefined || name.startsWith(`${wanted}-`));
  const all = entries.length > 0 ? entries : Object.entries(PRICE_TABLE);
  return { inputNano: Math.max(...all.map(([, p]) => p.inputNano)), outputNano: Math.max(...all.map(([, p]) => p.outputNano)) };
}

export type PriceSource = "env" | "table" | "fallback";

// Build an environment-variable name: `gemini-2.5-flash-lite` → `LLM_PRICE_GEMINI_2_5_FLASH_LITE`.
export function priceEnvName(model: string): string {
  return `LLM_PRICE_${model.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

// Environment value: `<input>,<output>` (USD/million tokens, e.g. `0.30,2.50`). Unparseable values return null.
export function parsePriceEnv(raw: string | undefined): Price | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[,/]\s*(\d+(?:\.\d+)?)\s*$/.exec(raw ?? "");
  if (!match) return null;
  return usdPerMTok(Number(match[1]), Number(match[2]));
}

const warned = new Set<string>();

// Price precedence: LLM_PRICE_<name> override > price table (dated names like `claude-haiku-4-5-20251001` match a listed name followed by `-`) > provider maximum (fallbackPriceFor).
// Overrides support unlisted models and price revisions before table updates.
export function priceFor(model: string, env: LlmEnv = process.env, provider?: string): { price: Price; source: PriceSource } {
  const name = priceEnvName(model);
  const raw = env[name];
  if (raw !== undefined && raw.trim() !== "") {
    const price = parsePriceEnv(raw);
    if (price) return { price, source: "env" };
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[llm] ${name} must look like "<input>,<output>" (USD per 1M tokens); ignoring "${raw}"`);
    }
  }
  const key = Object.keys(PRICE_TABLE)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (key) return { price: PRICE_TABLE[key], source: "table" };
  return { price: fallbackPriceFor(model, provider), source: "fallback" };
}

// Integer microdollar cost. Fake engines are free.
export function costMicro(
  engine: EngineId | string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  env: LlmEnv = process.env,
): number {
  if (engine === "fake") return 0;
  const { price } = priceFor(model, env, engine);
  return Math.ceil((inputTokens * price.inputNano + outputTokens * price.outputNano) / 1000);
}
