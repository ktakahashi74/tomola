// Browser-side selection/URL construction for 「AIで開く」, and local choice storage.
// Choices: ChatGPT, Claude, or Other with a user-provided https URL template containing {prompt}.
// Replace {prompt} with URL-encoded prompt text.

export const AI_CHOICE_STORAGE_KEY = "tomola.openInAi";
export const PROMPT_PLACEHOLDER = "{prompt}";
export const CHATGPT_TEMPLATE = "https://chatgpt.com/?q={prompt}";
export const CLAUDE_TEMPLATE = "https://claude.ai/new?q={prompt}";
export const OPEN_IN_AI_TTL_SECONDS = 5 * 60;
export const AI_OPEN_CHECK_DELAY_MS = 30 * 1000;
export const AI_OPEN_CHECK_INTERVAL_MS = 15 * 1000;

// Only used to stop browser polling; the server independently verifies credentials.
export function aiOpenLinkExpiresAt(link: string): number | null {
  try {
    const params = new URL(link).searchParams;
    const key = params.get("k");
    const marker = params.get("o");
    const expiry = key?.startsWith("oai2.") ? key.split(".").at(-4) : marker?.startsWith("oar1.") ? marker.split(".")[1] : undefined;
    return expiry && /^\d{1,12}$/.test(expiry) ? Number(expiry) * 1000 : null;
  } catch { return null; }
}
const MAX_TEMPLATE_LENGTH = 2000;

export type AiChoice = { provider: "chatgpt" } | { provider: "claude" } | { provider: "custom"; template: string };

// Usable template: https, includes {prompt}, no username/password, within length cap.
export function isValidTemplate(template: string): boolean {
  if (template.length > MAX_TEMPLATE_LENGTH || !template.includes(PROMPT_PLACEHOLDER)) return false;
  try {
    const url = new URL(template.replaceAll(PROMPT_PLACEHOLDER, "x"));
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname !== "";
  } catch {
    return false;
  }
}

export function templateOf(choice: AiChoice): string {
  if (choice.provider === "chatgpt") return CHATGPT_TEMPLATE;
  if (choice.provider === "claude") return CLAUDE_TEMPLATE;
  return choice.template;
}

// Opening URL: replace every {prompt} occurrence with URL-encoded prompt.
export function buildOpenUrl(choice: AiChoice, prompt: string): string {
  return templateOf(choice).replaceAll(PROMPT_PLACEHOLDER, encodeURIComponent(prompt));
}

// Read localStorage choice; malformed values/invalid templates return null to require choosing again.
export function parseChoice(raw: string | null): AiChoice | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { provider, template } = value as { provider?: unknown; template?: unknown };
    if (provider === "chatgpt" || provider === "claude") return { provider };
    if (provider === "custom" && typeof template === "string" && isValidTemplate(template)) return { provider, template };
  } catch {
    // Malformed value.
  }
  return null;
}

export function serializeChoice(choice: AiChoice): string {
  return JSON.stringify(choice);
}

export function readChoice(): AiChoice | null {
  try {
    return parseChoice(window.localStorage.getItem(AI_CHOICE_STORAGE_KEY));
  } catch {
    // localStorage is unavailable, for example in private browsing; the choice is not persisted.
    return null;
  }
}

export function saveChoice(choice: AiChoice | null) {
  try {
    if (choice) window.localStorage.setItem(AI_CHOICE_STORAGE_KEY, serializeChoice(choice));
    else window.localStorage.removeItem(AI_CHOICE_STORAGE_KEY);
    return true;
  } catch {
    // Opening still works for this attempt even if persistence fails.
    return false;
  }
}
