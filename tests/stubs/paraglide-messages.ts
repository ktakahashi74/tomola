// Test replacement through the vitest.config.ts alias. Route tests do not inspect wording, so every message returns an empty string
// to allow tests to run without generated app/paraglide files.
type Message = (params?: Record<string, unknown>, options?: { locale?: string }) => string;
let messages: Record<string, Message> | undefined;
// Setup can cache shared helpers before a test's message mock is installed.
export function setTestMessages(value?: Record<string, Message>) { messages = value; }
export const m = new Proxy({} as Record<string, Message>, {
  get: (_target, key) => (params?: Record<string, unknown>, options?: { locale?: string }) => messages?.[String(key)]?.(params, options) ?? "",
});
