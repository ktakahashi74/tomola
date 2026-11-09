import { isDevOrTest } from "~/lib/env.server";

function envOrDevDefault(name: string, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isDevOrTest()) return devDefault;
  throw new Error(`${name} is required unless NODE_ENV is development or test`);
}

// Derive keys for signatures outside Better Auth here too: signed links (app/lib/open-in-ai.server.ts) and rate-limit key HMACs (app/lib/rate-limit.server.ts).
export function authSecret(): string {
  return envOrDevDefault("BETTER_AUTH_SECRET", "dev-only-secret-do-not-use-in-production-000000");
}
