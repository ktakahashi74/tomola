import fs from "node:fs";
import path from "node:path";
import type { Lang } from "~/lib/languages";
import { glossaryFor } from "./ui-glossary";
import { mergeMessages, missingKeys, replaceMessages, REFERENCE_LOCALE, SOURCE_LOCALE, type Messages } from "./messages";
import { HASHES_FILE, parseHashes, serializeHashes, stamp, staleKeys, type SourceHashes } from "./source-hashes";
import { translateMessages, type Complete } from "./translate-messages.server";
import { parseChecks, parseVerified, serializeVerified, VERIFIED_FILE, type VerificationChecks, type Verified } from "./verification";

// Read/write message files (messages/<language>.json and source fingerprints in messages/.source-hashes.json) to generate translations; used by scripts/i18n-translate.ts.
// Inject complete through arguments so tests use a fake function to verify update rules: replace only stale keys and record fingerprints only after acceptance.

export const readMessages = (dir: string, locale: string): Messages | null => {
  const file = path.join(dir, `${locale}.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Messages) : null;
};
export const writeMessages = (dir: string, locale: string, messages: Messages): void =>
  fs.writeFileSync(path.join(dir, `${locale}.json`), `${JSON.stringify(messages, null, 2)}\n`);
export const readHashes = (dir: string): SourceHashes | null => {
  const file = path.join(dir, HASHES_FILE);
  return fs.existsSync(file) ? parseHashes(fs.readFileSync(file, "utf8")) : null;
};
export const writeHashes = (dir: string, hashes: SourceHashes, source: Messages): void => fs.writeFileSync(path.join(dir, HASHES_FILE), serializeHashes(hashes, source));
// Native-speaker verification records (verification.ts). No file means no verification.
export const readVerified = (dir: string): Verified => {
  const file = path.join(dir, VERIFIED_FILE);
  return fs.existsSync(file) ? parseVerified(fs.readFileSync(file, "utf8")) : {};
};
// Reviewer/date records per language.
export const readVerifiedChecks = (dir: string): VerificationChecks => {
  const file = path.join(dir, VERIFIED_FILE);
  return fs.existsSync(file) ? parseChecks(fs.readFileSync(file, "utf8")) : {};
};
// Without checks, retain the file's existing records unchanged.
export const writeVerified = (dir: string, verified: Verified, source: Messages, files: Record<string, Messages>, checks: VerificationChecks = readVerifiedChecks(dir)): void =>
  fs.writeFileSync(path.join(dir, VERIFIED_FILE), serializeVerified(verified, source, files, undefined, checks));

export type Mode = "missing" | "stale";

// Keys to translate per language: missing means no translation; stale means the recorded source fingerprint differs from the current source.
export function keysToTranslate(dir: string, locale: Lang, mode: Mode, limit = Infinity): string[] {
  const source = readMessages(dir, SOURCE_LOCALE);
  if (!source) throw new Error(`${SOURCE_LOCALE}.json is required`);
  const existing = readMessages(dir, locale) ?? { $schema: source.$schema };
  const keys = mode === "stale" ? staleKeys(source, existing, readHashes(dir)?.[locale]) : missingKeys(source, existing);
  return keys.slice(0, limit);
}

export type FileRunOptions = {
  dir: string;
  locales: readonly Lang[];
  mode: Mode;
  complete: Complete;
  batchSize?: number;
  limit?: number;
  // Number of languages translated concurrently.
  concurrency?: number;
  shouldStop?: () => string | null;
  log?: (message: string) => void;
};

export type FileRunSummary = { locale: string; keys: number; added: number; failed: Record<string, string[]>; calls: number; retried: number; stopped: string | null };

// Translate and write files. On each accepted batch, first write translations, then record those keys' source fingerprints. Failed keys are unwritten and retain fingerprints.
// Add missing keys only; replace only stale keys. Leave other keys/languages unchanged.
export async function translateFiles(opts: FileRunOptions): Promise<FileRunSummary[]> {
  const source = readMessages(opts.dir, SOURCE_LOCALE);
  const reference = readMessages(opts.dir, REFERENCE_LOCALE);
  if (!source || !reference) throw new Error(`${SOURCE_LOCALE}.json and ${REFERENCE_LOCALE}.json are required`);
  let hashes = readHashes(opts.dir);
  if (hashes === null) throw new Error(`messages/${HASHES_FILE} is missing (create it once with pnpm i18n:translate --init-hashes)`);
  const summary: FileRunSummary[] = [];
  const queue = [...opts.locales];
  const worker = async () => {
    for (let locale = queue.shift(); locale; locale = queue.shift()) {
      const keys = keysToTranslate(opts.dir, locale, opts.mode, opts.limit);
      let current = readMessages(opts.dir, locale) ?? { $schema: source.$schema };
      const result = await translateMessages({
        locale,
        source,
        reference,
        keys,
        batchSize: opts.batchSize,
        complete: opts.complete,
        glossary: glossaryFor(locale),
        log: opts.log,
        shouldStop: opts.shouldStop,
        onAccepted: (accepted) => {
          current = opts.mode === "stale" ? replaceMessages(source, current, accepted) : mergeMessages(source, current, accepted);
          writeMessages(opts.dir, locale, current);
          hashes = stamp(hashes!, locale, source, Object.keys(accepted));
          writeHashes(opts.dir, hashes, source);
        },
      });
      summary.push({ locale, keys: keys.length, added: Object.keys(result.translated).length, failed: result.failed, calls: result.calls, retried: result.retriedKeys, stopped: result.stopped });
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, opts.locales.length) }, worker));
  return summary;
}

export type DropStaleSummary = { locale: string; keys: number; hashes: number };

// Remove obsolete translations and orphan fingerprints without using a provider. Keep current translations, even when identical to English.
export function dropStaleFiles(opts: { dir: string; locales: readonly Lang[] }): DropStaleSummary[] {
  const source = readMessages(opts.dir, SOURCE_LOCALE);
  if (!source) throw new Error(`${SOURCE_LOCALE}.json is required`);
  const hashes = readHashes(opts.dir);
  if (hashes === null) throw new Error(`messages/${HASHES_FILE} is missing (create it once with pnpm i18n:translate --init-hashes)`);
  const summary: DropStaleSummary[] = [];
  let hashesChanged = false;
  for (const locale of opts.locales) {
    const existing = readMessages(opts.dir, locale);
    const current = existing ?? {};
    const remove = new Set(staleKeys(source, current, hashes[locale]));
    for (const key of Object.keys(current)) if (key !== "$schema" && !(key in source)) remove.add(key);
    const kept = Object.fromEntries(Object.entries(current).filter(([key]) => !remove.has(key)));
    const records = hashes[locale] ?? {};
    const removedRecords = Object.keys(records).filter(key => key === "$schema" || !(key in source) || !(key in kept));
    summary.push({ locale, keys: remove.size, hashes: removedRecords.length });
    if (existing && remove.size > 0) writeMessages(opts.dir, locale, mergeMessages(source, kept, {}));
    if (removedRecords.length > 0) {
      for (const key of removedRecords) delete records[key];
      hashesChanged = true;
    }
  }
  if (hashesChanged) writeHashes(opts.dir, hashes, source);
  return summary;
}
