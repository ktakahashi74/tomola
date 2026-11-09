type Env = Record<string, string | undefined>;

// Read on each call, like the public-reading setting.
export function testSiteEnabled(env: Env = process.env): boolean {
  const value = env.TOMOLA_SITE_STAGE?.trim() ?? "";
  if (value !== "" && value !== "test") throw new Error("TOMOLA_SITE_STAGE must be test or empty (unset)");
  return value === "test";
}
