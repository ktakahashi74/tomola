import { WIDE_RANGES } from "./east-asian-width.generated";

export type BodyKind = "topic" | "reply";
export const MAX_TOPIC_BODY_LENGTH = 100_000;
export const MAX_REPLY_BODY_LENGTH = 50_000;
export const MAX_BODY_BYTES = 256 * 1024;
// Translations may expand beyond the source limit. Bound manual corrections
// separately by bytes. Even sixfold form expansion (LF to CRLF plus percent
// encoding) leaves 128 KiB for other fields under the 2 MiB request limit.
export const MAX_TRANSLATION_BODY_BYTES = 320 * 1024;

function wide(point: number): boolean {
  let low = 0, high = WIDE_RANGES.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const [start, end] = WIDE_RANGES[mid];
    if (point < start) high = mid - 1;
    else if (point > end) low = mid + 1;
    else return true;
  }
  return false;
}

// Normalize only for counting; preserve the author's submitted source on save.
export function topicBodyLength(body: string): number {
  let length = 0;
  for (const char of body.normalize("NFC")) length += wide(char.codePointAt(0)!) ? 2 : 1;
  return length;
}

export const bodyLength = (body: string, kind: BodyKind): number => kind === "topic" ? topicBodyLength(body) : body.length;
export const bodyLimit = (kind: BodyKind): number => kind === "topic" ? MAX_TOPIC_BODY_LENGTH : MAX_REPLY_BODY_LENGTH;
export const bodyWithinLimits = (body: string, kind: BodyKind): boolean =>
  new TextEncoder().encode(body).byteLength <= MAX_BODY_BYTES && bodyLength(body, kind) <= bodyLimit(kind);
