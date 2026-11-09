import fs from "node:fs";

let cached: { file: string; checkedAt: number; active: boolean } | undefined;
// Share one stat per second between requests and all job lanes.
export function maintenanceActive(env: Record<string, string | undefined> = process.env): boolean {
  const file = env.MAINTENANCE_FLAG_FILE?.trim() || "/tmp/tomola-maintenance";
  const now = Date.now();
  if (cached?.file === file && now >= cached.checkedAt && now - cached.checkedAt < 1000) return cached.active;
  let active = true;
  try { fs.statSync(file); }
  catch (error) { active = (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  cached = { file, checkedAt: now, active };
  return active;
}
