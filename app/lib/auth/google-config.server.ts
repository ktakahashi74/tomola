export function googleLoginConfig(env: Record<string, string | undefined> = process.env) {
  if (env.GOOGLE_LOGIN !== undefined && env.GOOGLE_LOGIN !== "" && env.GOOGLE_LOGIN !== "1") throw new Error("GOOGLE_LOGIN must be 1 or empty");
  if (env.GOOGLE_LOGIN !== "1") return null;
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("GOOGLE_LOGIN requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  return { clientId, clientSecret };
}
