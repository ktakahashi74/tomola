type Env = Record<string, string | undefined>;
type ParsedOperatorOnlyInvitations = { ok: true; enabled: boolean } | { ok: false; error: string };

export function parseOperatorOnlyInvitations(raw: string | undefined): ParsedOperatorOnlyInvitations {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "1") return { ok: true, enabled: value === "1" };
  return { ok: false, error: "OPERATOR_ONLY_INVITATIONS must be 1 or empty (unset)" };
}

export function operatorOnlyInvitations(env: Env = process.env): boolean {
  const parsed = parseOperatorOnlyInvitations(env.OPERATOR_ONLY_INVITATIONS);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.enabled;
}

export function canCreateInvitations(operator: boolean, env: Env = process.env): boolean {
  return !operatorOnlyInvitations(env) || operator;
}
