import type { Processor } from "unified";

const HTML_BLOCK_NAMES = new Set(("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul").split(" "));
function isPhrasingHtml(value: string): boolean {
  const tag = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(value);
  if (!tag) return false;
  const name = tag[2].toLowerCase();
  return !HTML_BLOCK_NAMES.has(name) && Boolean(tag[1] || value[tag[0].length] === "/" || !["pre", "script", "style", "textarea"].includes(name));
}

// The CJK extensions handle attention themselves. Keep a break before block
// HTML from moving the following text out of its paragraph during serialization.
export function remarkEditorAttention(this: Processor) {
  // Register after the CJK plugins that remarkMarkdownRules queues while freezing.
  this.use(function () {
    const data = this.data();
    const extensions = data.toMarkdownExtensions ??= [];
    const root = extensions.map(extension => extension.handlers?.root).reverse().find(Boolean);
    const table = extensions.map(extension => extension.handlers?.table).reverse().find(Boolean);
    if (!root) throw new Error("Expected the CJK Markdown root handler");
    if (!table) throw new Error("Expected the GFM table handler");
    extensions.push({ handlers: {
      table(node, parent, state, info) {
        // Milkdown omits children for empty cells created by table commands.
        for (const row of node.children) for (const cell of row.children) cell.children ??= [];
        return table(node, parent, state, info);
      },
      root(node, parent, state, info) {
        const hardBreak = state.handlers.break;
        state.handlers.break = (node, parent, state, info) => {
          const next = parent && "children" in parent ? parent.children[state.indexStack.at(-1)! + 1] : undefined;
          if (next?.type === "html" && !isPhrasingHtml(next.value)) return hardBreak(node, parent, state, info).replace(/(\r\n|\r|\n)$/, " ");
          return hardBreak(node, parent, state, info);
        };
        return root(node, parent, state, info);
      },
    } });
  });
  // Markdown drops trailing blank lines from its tree. Keep the final paragraph
  // boundary as an empty typing paragraph when adopting a prefilled document.
  // Milkdown's doc schema omits the final empty paragraph on serialization.
  return (tree: { type: string; children?: Array<{ type: string; children?: unknown[] }> }, file: { value: unknown }) => {
    const children = tree.children;
    const last = children?.at(-1);
    if (children && last && !(last.type === "paragraph" && last.children?.length === 0) && /\r?\n[\t ]*\r?\n[\t ]*$/.test(String(file.value))) {
      children.push({ type: "paragraph", children: [] });
    }
  };
}
