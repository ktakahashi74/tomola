import fs from "node:fs";
import path from "node:path";
import { parseReviewCounts, type ReviewCounts } from "./review-counts";

// Reads app/lib/i18n/review-counts.generated.json (written by `pnpm build`; git-ignored). Returns null when there is no usable file.
//   - In the Vite build (the production server) and the dev server, import.meta.glob embeds the file at build time. A glob with no match is {} and never throws,
//     so a working tree without the generated file still builds and runs (development and tests do not check the counts).
//   - Under tsx (pnpm langs:open and the other scripts) import.meta.glob does not exist; the file is read from disk next to this module instead
//     (the production image has the whole app/ directory).
const embedded = (() => {
  try {
    return import.meta.glob<unknown>("./review-counts.generated.json", { eager: true, import: "default" });
  } catch {
    return null;
  }
})();

export const REVIEW_COUNTS_FILE = "review-counts.generated.json";

export function loadReviewCounts(): ReviewCounts | null {
  if (embedded !== null) {
    const found = Object.values(embedded)[0];
    return found === undefined ? null : parseReviewCounts(found);
  }
  try {
    return parseReviewCounts(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, REVIEW_COUNTS_FILE), "utf8")));
  } catch {
    return null;
  }
}
