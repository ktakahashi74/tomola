import { createMarkdownProcessor as create } from "./markdown-rules";

// Only worker operations use this module. Retain two immutable syntax trees so
// extraction and translation checks can reuse a parse without sharing mutations.
const trees = new Map<string, ReturnType<ReturnType<typeof create>["parse"]>>();
let cacheEnabled = true;
export function withoutMarkdownParseCache<T>(work: () => T): T {
  const previous = cacheEnabled;
  cacheEnabled = false;
  try { return work(); } finally { cacheEnabled = previous; }
}
export function createMarkdownProcessor(): ReturnType<typeof create> {
  const processor = create();
  const parse = processor.parse.bind(processor);
  processor.parse = (file) => {
    const source = typeof file === "string" ? file : String(file && "value" in file ? file.value : file ?? "");
    const saved = cacheEnabled ? trees.get(source) : undefined;
    if (saved) return structuredClone(saved);
    const tree = parse(file);
    // This is a cache bound, not a restriction on accepted Markdown.
    if (cacheEnabled && source.length <= 50_000) {
      if (trees.size >= 2) trees.delete(trees.keys().next().value!);
      trees.set(source, structuredClone(tree));
    }
    return tree;
  };
  return processor;
}
