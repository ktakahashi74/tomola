import { avatarSvg } from "~/lib/avatar-image.server";
import { getMediaReader } from "~/lib/media-reader.server";

export async function loader({ request, params }: { request: Request; params: { file?: string } }) {
  const safety = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin", "Content-Type": "image/svg+xml" };
  const missing = () => new Response(null, { status: 404, headers: { ...safety, "Cache-Control": "no-store" } });
  const seed = /^([a-f0-9]{64})\.svg$/.exec(params.file ?? "")?.[1];
  if (!seed) return missing();
  try {
    if (!await getMediaReader(request)) return missing();
    const headers = { ...safety, "Cache-Control": "private, max-age=86400", ETag: `"${seed}"` };
    const body = avatarSvg(seed);
    if (request.headers.get("if-none-match")?.split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === headers.ETag)) return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : body, { headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) } });
  } catch (error) {
    if (error instanceof Response && error.status === 429) return new Response(null, { status: 429, headers: { ...safety, "Cache-Control": "no-store", "Retry-After": error.headers.get("Retry-After") ?? "60" } });
    return missing();
  }
}
