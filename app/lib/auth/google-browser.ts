export function googleBrowserBlocked(ua: string): boolean {
  return /Line\/|\bFBAN\b|\bFBAV\b|FB_IAB|Messenger|Instagram|LinkedIn|\bLIAPP\b|KAKAOTALK|NAVER[^\n]*inapp|MicroMessenger|; wv\)/i.test(ua);
}

export function googleBrowserFromRequest(request: Request) {
  const url = new URL(request.url);
  // Client navigation uses a data request; copy the document URL it represents.
  if (url.pathname.endsWith(".data")) {
    url.pathname = url.pathname.replace(/\/_\.data$/, "/").replace(/\.data$/, "");
    url.searchParams.delete("_routes");
  }
  url.hash = "";
  return { blocked: googleBrowserBlocked(request.headers.get("user-agent") ?? ""), url: url.href };
}
