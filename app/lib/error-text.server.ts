import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm";

// Query errors embed bound values in their message and stack. Search wrappers
// before formatting anything, including messages that copied a nested error.
export function safeErrorText(error: unknown, opts: { stack?: boolean; name?: boolean } = {}): string {
  const queries: string[] = [];
  const seen = new Set<object>();
  let truncated = false;
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    if (depth > 12) { truncated = true; return; }
    seen.add(value);
    if (value instanceof DrizzleQueryError || ("query" in value && typeof value.query === "string" && "params" in value && Array.isArray(value.params))) {
      const query = (value as DrizzleQueryError).query;
      const cause = "cause" in value ? value.cause : null;
      const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" && /^[A-Z0-9_]{1,64}$/.test(cause.code) ? cause.code : "unknown";
      queries.push(`DrizzleQueryError: ${query}\ncode: ${code}`);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    for (const key of ["cause", "error", "errors"] as const) if (key in value) visit((value as Record<string, unknown>)[key], depth + 1);
  };
  visit(error, 0);
  if (queries.length) return [...new Set(queries)].join("\n");
  if (truncated) return "Error details omitted: nested error limit";
  if (error instanceof Error) return opts.stack ? error.stack ?? `${error.name}: ${error.message}` : `${opts.name ? `${error.name}: ` : ""}${error.message}`;
  return typeof error === "string" ? error : inspect(error, { depth: 3 });
}
