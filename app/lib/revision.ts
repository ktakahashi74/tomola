export function revision(env: Record<string, string | undefined> = process.env): string {
  const value = env.REVISION?.trim() ?? "";
  return /^[a-f0-9]{7,64}$/i.test(value) ? value : "unknown";
}
export function shortRevision(value: string): string { return revision({ REVISION: value }).slice(0, 7); }
