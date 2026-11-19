export type Reauthentication = "1" | "moderation";

export function isReauthentication(value: unknown): value is Reauthentication {
  return value === "1" || value === "moderation";
}

// Re-verify a signed-in member and return to a local path, which the login route validates.
export function reauthenticationPath(next: string, reauth: Reauthentication = "1"): string {
  return `/login?${new URLSearchParams({ reauth, next })}`;
}
