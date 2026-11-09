import { getMediaReader } from "~/lib/media-reader.server";
import { readMedia } from "~/lib/media-store.server";
import { readFigureTranslation } from "~/lib/figure-translation.server";
import { parseMediaPath, parseTranslatedMediaPath } from "~/lib/media";
import { canReadMedia } from "~/lib/media-references.server";

export async function loader({ request }: { request: Request }) {
  const safety = {
    "Content-Type": "image/webp",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  const missing = () => new Response(null, { status: 404, headers: { ...safety, "Cache-Control": "no-store" } });
  const path = new URL(request.url).pathname;
  const translated = parseTranslatedMediaPath(path);
  const parsed = parseMediaPath(path) ?? translated;
  if (!parsed) return missing();
  try {
    const reader = await getMediaReader(request);
    if (!reader) return missing();
    const { db, viewer } = reader;
    if (!await canReadMedia(db, parsed.id, viewer)) return missing();
    const image = await readMedia(db, parsed.id);
    if (!image?.bytes || image.width !== parsed.width || image.height !== parsed.height) return missing();
    const variant = translated ? await readFigureTranslation(db, parsed.id, translated.lang, translated.version) : null;
    if (translated && !variant?.bytes) return missing();
    const bytes = variant?.bytes ?? image.bytes;
    const entity = `"${parsed.id}${translated ? `:${translated.lang}:v${translated.version}` : ""}"`;
    const headers = { ...safety, "Content-Type": image.mime, "Cache-Control": "private, max-age=86400", ETag: entity };
    if (request.headers.get("if-none-match")?.split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === entity)) return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), { headers: { ...headers, "Content-Length": String(bytes.length) } });
  } catch (error) {
    // Failures keep resource-safe headers and never disclose authentication details.
    if (error instanceof Response && error.status >= 300 && error.status < 400) return missing();
    const init = error instanceof Response ? error : error && typeof error === "object" && "init" in error ? (error as { init?: ResponseInit }).init : undefined;
    const status = init?.status && init.status >= 400 && init.status < 600 ? init.status : 500;
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(safety)) headers.set(name, value);
    headers.set("Cache-Control", "no-store");
    return new Response(null, { status, headers });
  }
}
