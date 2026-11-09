export function safeSettingsReturnPath(raw: string | null | undefined): string | null {
  if (!raw?.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw, "https://return.invalid");
    if (url.origin !== "https://return.invalid" || url.pathname.startsWith("//") || url.pathname.replace(/\/$/, "") === "/settings") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function withSettingsReturn(to: string, from: string | null | undefined): string {
  const path = safeSettingsReturnPath(from);
  if (!path) return to;
  const url = new URL(to, "https://return.invalid");
  url.searchParams.set("returnTo", path);
  return `${url.pathname}${url.search}${url.hash}`;
}
