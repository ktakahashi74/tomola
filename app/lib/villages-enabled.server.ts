type Env = Record<string, string | undefined>;
export type ParsedVillages = { ok: true; enabled: boolean } | { ok: false; error: string };

export function parseVillages(raw: string | undefined): ParsedVillages {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "1") return { ok: true, enabled: value === "1" };
  return { ok: false, error: "VILLAGES must be 1 or empty (unset)" };
}

export function villagesEnabled(env: Env = process.env): boolean {
  const parsed = parseVillages(env.VILLAGES);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.enabled;
}
