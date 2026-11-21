export type HomeScope = "all" | "following";

export function isHomeScope(value: unknown): value is HomeScope {
  return value === "all" || value === "following";
}

// Explicit scope wins over links from before the home switch was introduced.
export function parseHomeScope(params: URLSearchParams): HomeScope | "invalid" | null {
  const scope = params.get("scope");
  if (scope !== null) return isHomeScope(scope) ? scope : "invalid";
  return params.get("follow") === "1" ? "following" : null;
}

export const FOLLOWING_HOME_LIST_SCOPE = "/?scope=following";
