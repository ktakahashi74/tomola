import { data, redirect } from "react-router";

// A native form must finish on GET: refreshing a POST would send another
// email and replace the pending code. Fetch submissions retain action data.
export function loginCodeSent<T>(request: Request, payload: T, headers: Headers) {
  if (request.headers.get("accept")?.includes("text/html")) {
    const url = new URL(request.url);
    return redirect(`${url.pathname}${url.search}`, { status: 303, headers });
  }
  return data(payload, { headers });
}
