import { createHash } from "node:crypto";

// New source revisions bind their language too. Omitting it computes historical
// title/body hashes when recovering revisions predating language correction.
// PostgreSQL text cannot contain NUL, so the separators are unambiguous.
export function sourceHash(title: string | null, body: string, lang?: string): string {
  const hash = createHash("sha256")
    .update(title ?? "")
    .update("\0")
    .update(body);
  if (lang !== undefined) hash.update("\0").update(lang);
  return hash.digest("hex");
}
