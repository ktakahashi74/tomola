import { LANGS, type Lang } from "~/lib/languages";
import { POSITIONS, REASON_SLOTS, type Position } from "~/lib/stances";

// The pure part of the reasons panel: which tagged replies fill the panel. It reads no database and is browser-safe.
//
// The panel has up to REASON_SLOTS slots for each position (agree / disagree / neither).
// Each slot starts with replies by writers not yet shown anywhere in the panel. If any original languages have not yet appeared in this position,
// draw one of those languages uniformly and keep only its replies. Then prefer replies with at least one counted Insightful, if any, draw a writer
// uniformly from that pool, and draw one of that writer's replies uniformly. After all languages have appeared, apply the same preference to all remaining replies.
// The result is independent of the reader's language, area or stance. It uses no AI or Insightful count, only a boolean signal after the language draw.
// All randomness comes from the caller's generator: the page seed is the question and UTC date (reasonsSeed), shared by everyone.

// lang is the reply's original language (entries.lang). The writer's home area (profiles.home_area) is not used: what the reader sees is the language of the text. zh-Hans and zh-Hant are
// two languages.
export type ReasonCandidate = { entryId: number; authorId: string; lang: Lang; position: Position; insightful: boolean };
// The ids of the replies in the slots of each position, in slot order.
export type ReasonPick = Record<Position, number[]>;

// mulberry32: a deterministic generator from a 32-bit seed. Returns numbers in [0, 1).
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The seed of the draw: FNV-1a (32 bits) of "<question id>:<YYYY-MM-DD>", the date in UTC. The same for everyone, changing at 00:00 UTC. No secret is mixed in, so that anyone can check
// the rule.
export function reasonsSeed(questionId: number, now: Date): number {
  const text = `${questionId}:${now.toISOString().slice(0, 10)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function pickOne<T>(items: readonly T[], rng: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pickReasons(candidates: readonly ReasonCandidate[], opts: { rng: () => number; slots?: number }): ReasonPick {
  const slots = opts.slots ?? REASON_SLOTS;
  const rng = opts.rng;
  // Sorted by entry id, so that the order the database happens to return does not decide the result.
  const sorted = [...candidates].sort((a, b) => a.entryId - b.entryId);
  const pool = new Map<Position, ReasonCandidate[]>(POSITIONS.map((p) => [p, sorted.filter((c) => c.position === p)]));
  const pick: ReasonPick = { agree: [], disagree: [], neither: [] };
  const usedWriters = new Set<string>();
  const shownLangs = new Map<Position, Set<Lang>>(POSITIONS.map((p) => [p, new Set<Lang>()]));
  for (let round = 0; round < slots; round++) {
    // The order of the positions is drawn again in every round, so that no position gets the first choice of writers every time.
    for (const position of shuffled(POSITIONS, rng)) {
      const eligible = (pool.get(position) ?? []).filter((c) => !usedWriters.has(c.authorId));
      if (eligible.length === 0) continue;
      const seen = shownLangs.get(position)!;
      const unseen = LANGS.filter((lang) => !seen.has(lang) && eligible.some((c) => c.lang === lang));
      let writerPool: ReasonCandidate[];
      if (unseen.length > 0) {
        const lang = pickOne(unseen, rng);
        writerPool = eligible.filter((c) => c.lang === lang);
      } else {
        writerPool = eligible;
      }
      const insightful = writerPool.filter((c) => c.insightful);
      if (insightful.length > 0) writerPool = insightful;
      const writers = [...new Set(writerPool.map((c) => c.authorId))].sort(compareText);
      const writer = pickOne(writers, rng);
      const chosen = pickOne(writerPool.filter((c) => c.authorId === writer), rng);
      pick[position].push(chosen.entryId);
      usedWriters.add(writer);
      seen.add(chosen.lang);
    }
  }
  return pick;
}
