// Operators are specified by comma-separated emails in OPERATOR_EMAILS.
// Compare emails case-insensitively after trimming whitespace.
export function operatorEmails(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.OPERATOR_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isOperatorEmail(email: string, env: Record<string, string | undefined> = process.env): boolean {
  return operatorEmails(env).has(email.trim().toLowerCase());
}
