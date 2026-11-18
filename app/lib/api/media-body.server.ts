import { MEDIA_LIMITS, MediaError } from "~/lib/media";

const MAX_PART_HEADERS = 8192;

// Accept exactly one file, without retaining its name or trusting its MIME type.
// Inspect the first part's headers while receiving, before a multipart parser
// could allocate an unbounded collection of fields or header values.
export async function readApiMedia(request: Request): Promise<Uint8Array> {
  const type = request.headers.get("content-type") ?? "";
  const multipart = /^multipart\/form-data\s*;/i.test(type);
  const boundaryMatch = multipart ? /^multipart\/form-data\s*;\s*boundary=(?:"([\x20-\x7e]{1,70})"|([\x21-\x7e]{1,70}))\s*$/i.exec(type) : null;
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (multipart ? !boundary : !/^(?:application\/octet-stream|image\/[a-z0-9.+-]+)(?:\s*;.*)?$/i.test(type)) throw new MediaError("type");
  const limit = multipart ? MEDIA_LIMITS.requestBytes : MEDIA_LIMITS.inputBytes;
  const announced = request.headers.get("content-length");
  if (announced !== null && (!/^\d+$/.test(announced) || Number(announced) > limit)) throw new MediaError("too_large", 413);
  if (!request.body) throw new MediaError("generic");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        // One bounded allocation also caps bookkeeping for arbitrarily small chunks.
        const buffer = Buffer.allocUnsafe(limit);
        const opening = Buffer.from(`--${boundary}\r\n`);
        let size = 0, headerEnd = -1;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new MediaError("too_large", 413);
          buffer.set(value, size - value.byteLength);
          if (multipart && headerEnd < 0) {
            // Copy only the bounded header prefix while it is incomplete.
            const prefix = buffer.subarray(0, Math.min(size, opening.length + MAX_PART_HEADERS + 4));
            if (!prefix.subarray(0, Math.min(prefix.length, opening.length)).equals(opening.subarray(0, Math.min(prefix.length, opening.length)))) throw new MediaError("generic");
            headerEnd = prefix.indexOf("\r\n\r\n", opening.length);
            if (headerEnd < 0 && size >= opening.length + MAX_PART_HEADERS + 4) throw new MediaError("too_large", 413);
            if (headerEnd >= 0) {
              if (headerEnd - opening.length > MAX_PART_HEADERS) throw new MediaError("too_large", 413);
              const headers = prefix.subarray(opening.length, headerEnd).toString("latin1").split("\r\n");
              if (headers.length > 16) throw new MediaError("too_large", 413);
              const seen = new Set<string>();
              for (const line of headers) {
                const header = /^([a-z0-9-]+):[ \t]*([^\r\n\x00]*)$/i.exec(line);
                if (!header || seen.has(header[1].toLowerCase())) throw new MediaError("generic");
                seen.add(header[1].toLowerCase());
              }
              const disposition = headers.find(line => /^content-disposition:/i.test(line));
              if (!disposition || !/^content-disposition:\s*form-data\s*;/i.test(disposition) || !/;\s*name="[^"\r\n]*"/i.test(disposition) || !/;\s*filename(?:="[^"\r\n]*"|\*=.+)/i.test(disposition)) throw new MediaError("generic");
            }
          }
          if (multipart && headerEnd >= 0 && size - headerEnd - 4 > MEDIA_LIMITS.inputBytes + boundary!.length + 8) throw new MediaError("too_large", 413);
        }
        const bytes = buffer.subarray(0, size);
        if (!multipart) {
          if (!bytes.length) throw new MediaError("generic");
          return Buffer.from(bytes);
        }
        if (headerEnd < 0) throw new MediaError("generic");
        const start = headerEnd + 4;
        const delimiter = Buffer.from(`\r\n--${boundary}`);
        // A valid delimiter is followed by CRLF (another part) or -- (closing).
        let end = bytes.indexOf(delimiter, start);
        while (end >= 0 && !["\r\n", "--"].includes(bytes.subarray(end + delimiter.length, end + delimiter.length + 2).toString())) end = bytes.indexOf(delimiter, end + 1);
        if (end < 0 || !["--", "--\r\n"].includes(bytes.subarray(end + delimiter.length).toString())) throw new MediaError("generic");
        if (end - start > MEDIA_LIMITS.inputBytes) throw new MediaError("too_large", 413);
        if (end === start) throw new MediaError("generic");
        return Buffer.from(bytes.subarray(start, end));
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MediaError("generic", 408)), MEDIA_LIMITS.receivingMs); }),
    ]);
  } catch (error) { throw error instanceof MediaError ? error : new MediaError("generic"); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
