import type { Lang } from "../languages";

const decimalCommaLanguages: ReadonlySet<string> = new Set(["fr", "de", "vi"] satisfies Lang[]);
const textCommand = /^\\(?:text|textrm|textit|textbf|textsf|mbox)\s*\{$/;
const texTokens = /\\[A-Za-z]+\s*\{|\\[A-Za-z]+|\\[\s\S]|%[^\n]*|[{}]/g;

// Retain TeX grouping, control symbols and inline formulas inside a label.
// Leave arguments with commands, comments or unmatched dollars verbatim.
function labelContents(label: string): string | null {
  const tokens = label.match(/\$(?:\\[\s\S]|[^$\\])*\$|\\[\s\S]|[{}$%#&_^~]/g) ?? [];
  if (tokens.some(token => /^(?:\\[^%&#_$}{ ]|[$%#&_^~]$|\$\$)/.test(token))) return null;
  return tokens.join("");
}

function* mathLabels(formula: string) {
  let depth = 0;
  let label: { command: number; start: number; depth: number } | undefined;
  for (const { 0: token, index } of formula.matchAll(texTokens)) {
    if (token === "{" || /^\\[A-Za-z]+\s*\{$/.test(token)) {
      depth++;
      if (!label && textCommand.test(token)) label = { command: index, start: index + token.length, depth };
    } else if (token === "}") {
      if (label?.depth === depth) {
        yield { ...label, end: index };
        label = undefined;
      }
      depth = Math.max(0, depth - 1);
    }
  }
  if (label) yield { ...label, end: formula.length };
}

function normalizeMathLabels(formula: string): string {
  if (!formula.includes("\\")) return formula;
  let cursor = 0;
  const parts: string[] = [];
  for (const { start, end } of mathLabels(formula)) {
    if (end === formula.length) break;
    const contents = labelContents(formula.slice(start, end));
    if (contents !== null) {
      parts.push(formula.slice(cursor, start), contents);
      cursor = end;
    }
  }
  return parts.length ? parts.join("") + formula.slice(cursor) : formula;
}

type Formula = { shape: string; separators: string };
// A plain comma inside a delimited group can split coordinates or arguments.
// The grouping braces in {,} mark its use as part of a number there.
const openGroup = /^(?:[([\u27e8]|\\(?:\{|lbrace|langle|lparen|lbrack|lvert|lVert|begin))$/;
const closeGroup = /^(?:[)\]\u27e9]|\\(?:\}|rbrace|rangle|rparen|rbrack|rvert|rVert|end))$/;
const numberOrTex = /\d+(?:(?:[.,]|\{,\})\d+)*|\\[A-Za-z]+|\\[\s\S]|%[^\n]*|[()[\]\u27e8\u27e9]/g;

function formulaKey(formula: string, localize: boolean): Formula {
  if (!localize) return { shape: JSON.stringify([formula]), separators: "" };
  let depth = 0, cursor = 0;
  const parts: string[] = [];
  const separators: string[] = [];
  // Text arguments have already been compared as labels. Skip them here so any
  // math retained inside a label is compared character for character.
  const labelEnds = new Map(Array.from(mathLabels(formula), label => [label.command, label.end]));
  let protectedUntil = -1;
  for (const { 0: token, index } of formula.matchAll(numberOrTex)) {
    if (index <= protectedUntil) continue;
    protectedUntil = labelEnds.get(index) ?? -1;
    if (openGroup.test(token)) depth++;
    else if (closeGroup.test(token)) depth = Math.max(0, depth - 1);
    // An unbraced TeX subscript or exponent consumes just its first token.
    if (!/^\d/.test(token) || /[\^_]/.test(formula[index - 1] ?? "") || /\.\d+\./.test(token)) continue;
    const marks = [...token.matchAll(/(?<=\d)(?:[.,]|\{,\})(?=\d)/g)];
    for (const { 0: mark, index: offset } of marks) {
      if (mark === "," && (depth > 0 || marks.length !== 1)) continue;
      parts.push(formula.slice(cursor, index + offset));
      separators.push(mark === "{,}" ? "b" : mark);
      cursor = index + offset + mark.length;
    }
  }
  parts.push(formula.slice(cursor));
  return { shape: JSON.stringify(parts), separators: separators.join("") };
}

const canLocalize = (source: string, target: string) =>
  [...source].every((mark, i) => mark === target[i] || mark === "." && (target[i] === "," || target[i] === "b"));

// Match occurrences one to one, allowing only source periods to change. Return
// the unused target indices, or null if any source formula was lost.
export function unmatchedMath(source: readonly string[], target: readonly string[], to?: string): number[] | null {
  if (source.length > target.length) return null;
  if (!source.length) return target.map((_, i) => i);
  if (source.length === target.length && source.every((value, i) => value === target[i])) return [];
  const localize = to !== undefined && decimalCommaLanguages.has(to);
  const a = source.map(value => formulaKey(normalizeMathLabels(value), localize));
  const b = target.map(value => formulaKey(normalizeMathLabels(value), localize));
  const exact = new Map<string, number[]>();
  const exactKey = ({ shape, separators }: Formula) => shape + separators;
  // Reverse order so pop() returns the first occurrence.
  for (let i = b.length - 1; i >= 0; i--) {
    const key = exactKey(b[i]);
    if (!exact.has(key)) exact.set(key, []);
    exact.get(key)!.push(i);
  }
  const owner = new Map<number, number>();
  const missing: number[] = [];
  for (const [i, formula] of a.entries()) {
    const match = exact.get(exactKey(formula))?.pop();
    if (match === undefined) missing.push(i);
    else owner.set(match, i);
  }
  if (!missing.length) return b.flatMap((_, i) => owner.has(i) ? [] : [i]);
  if (!localize) return null;

  // An exact match can stay fixed: localization is one-way and transitive,
  // so any valid assignment that split an exact pair can be exchanged.
  type Targets = { free: number[]; matched: number[] };
  const groups = new Map<string, Map<string, Targets>>();
  for (const [i, { shape, separators }] of b.entries()) {
    if (owner.has(i)) continue;
    if (!groups.has(shape)) groups.set(shape, new Map());
    const group = groups.get(shape)!;
    if (!group.has(separators)) group.set(separators, { free: [], matched: [] });
    group.get(separators)!.free.push(i);
  }

  for (const start of missing) {
    // Find a free target, rerouting previous matches when identical formula
    // shapes have different mixes of localized and original separators.
    const queue = [start], seen = new Set(queue);
    const paths = new Map<number, { source: number; target: number }>();
    let matched = false;
    for (let i = 0; i < queue.length && !matched; i++) {
      const s = queue[i], formula = a[s];
      for (const [separators, targets] of groups.get(formula.shape) ?? []) {
        if (!canLocalize(formula.separators, separators)) continue;
        const t = targets.free.pop();
        if (t !== undefined) {
          targets.matched.push(t);
          owner.set(t, s);
          for (let prior = paths.get(s); prior; prior = paths.get(prior.source)) owner.set(prior.target, prior.source);
          matched = true;
          break;
        }
        for (const target of targets.matched) {
          const previous = owner.get(target)!;
          if (seen.has(previous)) continue;
          seen.add(previous);
          paths.set(previous, { source: s, target });
          queue.push(previous);
        }
      }
    }
    if (!matched) return null;
  }
  return b.flatMap((_, i) => owner.has(i) ? [] : [i]);
}
