import { sourceHash } from "~/lib/source-hash.server";

// Bind the editable text and language through sourceHash, plus the reply label.
// Timestamps and revision counters are intentionally excluded: A -> B -> A is current again.
// Recompute the canonical hash: older stored hashes did not include language.
// Comparing their old encoding with a new edit's encoding would reject A -> B -> A.
export function entryEditVersion(entry: { title: string | null; body: string; lang: string; stanceTag: string | null }): string {
  return JSON.stringify([sourceHash(entry.title, entry.body, entry.lang), entry.stanceTag]);
}
