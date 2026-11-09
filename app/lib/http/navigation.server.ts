// Whether this is browser page navigation/form submission rather than fetch/fetcher. Prefer Sec-Fetch-Dest when present, as modern browsers provide it;
// otherwise check whether Accept includes text/html.
export function isNavigation(request: Request): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null) return dest === "document";
  return (request.headers.get("accept") ?? "").includes("text/html");
}
