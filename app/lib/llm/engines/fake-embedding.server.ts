import { EMBEDDING_DIM } from "~/lib/db/schema";
import type { EmbeddingEngine, EmbedRequest, EmbedResult } from "../types";
import { EMBEDDING_CONCEPTS } from "./embedding-concepts";

// Deterministic fake embedding engine for tests/keyless development. No network calls or cost.
// Build vectors with enough similarity to test search behavior in place of a real model:
//   1. Phrases from embedding-concepts.ts add CONCEPT_WEIGHT to their concept dimension (the first CONCEPT_SLOTS dimensions, in concept order).
//      Equivalent phrases across nine languages share dimensions, creating cross-language similarity.
//   2. Other Intl.Segmenter words (lowercase, NFKC) add 1 to hashed dimensions after CONCEPT_SLOTS, with sign determined by one hash bit.
//      These dimensions create similarity only between same-language texts sharing words.
//   3. L2-normalize. Empty text gets a fixed unit vector so cosine distance is not NaN.
export const FAKE_EMBEDDING_MODEL = "fake-embedding-1";
const CONCEPT_SLOTS = 64;
const CONCEPT_WEIGHT = 4;
// Cap the number of contributions from repeated occurrences of one concept.
const CONCEPT_MAX_COUNT = 3;

const normalize = (s: string) => s.normalize("NFKC").toLowerCase();

// FNV-1a, 32-bit.
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LATIN = /^[\p{Script=Latin}\s-]+$/u;

// Phrase-matching regexes, built once on startup. Latin-script phrases require non-letter/non-digit boundaries on both sides.
const conceptMatchers = EMBEDDING_CONCEPTS.map((concept) => ({
  patterns: concept.terms.map((term) => {
    const source = escapeRegExp(normalize(term));
    return new RegExp(LATIN.test(term) ? `(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])` : source, "gu");
  }),
}));

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export function fakeEmbeddingVector(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  const normalized = normalize(text);
  conceptMatchers.forEach((matcher, slot) => {
    let count = 0;
    for (const pattern of matcher.patterns) count += normalized.match(pattern)?.length ?? 0;
    if (count > 0) vec[slot] += CONCEPT_WEIGHT * Math.min(count, CONCEPT_MAX_COUNT);
  });
  for (const part of segmenter.segment(normalized)) {
    if (!part.isWordLike) continue;
    const h = fnv1a(part.segment);
    vec[CONCEPT_SLOTS + (h % (EMBEDDING_DIM - CONCEPT_SLOTS))] += (h >>> 31) & 1 ? -1 : 1;
  }
  const norm = Math.hypot(...vec);
  if (norm === 0) {
    vec[EMBEDDING_DIM - 1] = 1;
    return vec;
  }
  return vec.map((v) => v / norm);
}

export function createFakeEmbeddingEngine(): EmbeddingEngine {
  return {
    id: "fake",
    model: FAKE_EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    async embed(req: EmbedRequest): Promise<EmbedResult> {
      const text = req.title ? `${req.title}\n\n${req.text}` : req.text;
      return { vector: fakeEmbeddingVector(text), model: FAKE_EMBEDDING_MODEL, inputTokens: Math.ceil(text.length / 4) };
    },
  };
}
