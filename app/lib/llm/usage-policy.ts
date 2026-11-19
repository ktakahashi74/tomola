import type { BudgetState } from "./types";

// Key order matches the ledger's existing database constraint.
export const USAGE_POLICY = {
  translate: { budget: "public", role: "primary", duringDegraded: true },
  retry: { budget: "public", role: "retry", duringDegraded: false },
  judge: { budget: "public", role: "judge", duringDegraded: false },
  embed: { budget: "public", role: "embed", duringDegraded: true },
  chat: { budget: "chat", role: "chat", duringDegraded: false },
  moderation: { budget: "public", role: "primary", duringDegraded: true },
  ask: { budget: "postAsk", role: "ask", duringDegraded: false },
  ask_village: { budget: "nushi", role: "ask", duringDegraded: false },
  village_slug_suggest: { budget: "public", role: "secondary", duringDegraded: false },
} as const;

export type UsagePurpose = keyof typeof USAGE_POLICY;
export type UsageBudget = (typeof USAGE_POLICY)[UsagePurpose]["budget"];
export type UsageRole = (typeof USAGE_POLICY)[UsagePurpose]["role"];
export const USAGE_PURPOSES = Object.keys(USAGE_POLICY) as UsagePurpose[];

export function budgetAllows(state: BudgetState, purpose: UsagePurpose, role: UsageRole = USAGE_POLICY[purpose].role): boolean {
  const policy = USAGE_POLICY[purpose];
  return state === "normal" || (state === "degraded" && policy.duringDegraded && role === policy.role);
}
