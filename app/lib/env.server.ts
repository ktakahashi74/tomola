// Allow defaults only in allowlisted environments. Treat unset NODE_ENV the same as production.
export function isDevOrTest(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}
