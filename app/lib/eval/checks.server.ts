import type * as core from "./checks.core.server";
import { markdownTask } from "~/lib/markdown-budget.server";

export function deterministicCheck(...args: Parameters<typeof core.deterministicCheck>): Promise<ReturnType<typeof core.deterministicCheck>> {
  return markdownTask("deterministicCheck", args);
}
