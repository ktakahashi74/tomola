import { directiveFromMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";
import type { Processor } from "unified";

export type DetailsIssueReason = "name" | "unclosed" | "attributes" | "depth";

export type MarkdownNode = {
  type: string;
  name?: string;
  value?: string;
  alt?: string | null;
  label?: string | null;
  identifier?: string;
  attributes?: Record<string, unknown> | null;
  children?: MarkdownNode[];
  position?: { start: { offset?: number; line: number; column?: number }; end: { offset?: number } };
  data?: {
    detailsSource?: string;
    detailsIssue?: DetailsIssueReason;
    directiveLabel?: boolean;
    position?: { opening: { start: { offset?: number }; end: { offset?: number } }; closing?: unknown };
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
};

// Select the container at the tokenizer boundary. Registering text/leaf
// directives and undoing them later would lose literal colons and brackets.
export function registerMarkdownDetails(processor: Processor) {
  const flow = directive().flow?.[58];
  const containers = (Array.isArray(flow) ? flow : [flow]).filter((construct): construct is NonNullable<typeof construct> => construct !== undefined && construct.concrete === true);
  if (containers.length !== 1) throw new Error("Expected one concrete directive container");
  const data = processor.data();
  (data.micromarkExtensions ??= []).push({ flow: { 58: containers } });
  (data.fromMarkdownExtensions ??= []).push(directiveFromMarkdown({ verbose: true }));
  // Run at parse time, including for consumers that inspect parse() directly.
  // Source offsets retain the actual characters, including list indentation.
  const parse = processor.parser!;
  processor.parser = (source, file) => {
    const parsed = parse(source, file);
    const tree = parsed as unknown as MarkdownNode;
    const walk = (parent: MarkdownNode, depth: number) => {
      parent.children = parent.children?.map(node => {
        if (node.type === "containerDirective") {
          const raw = source.slice(node.position!.start.offset, node.position!.end.offset);
          const reason: DetailsIssueReason | undefined = node.name !== "details" ? "name"
            : !node.data?.position?.closing ? "unclosed"
              : Object.keys(node.attributes ?? {}).length > 0 || /\}\s*$/.test(source.slice(node.data.position.opening.start.offset, node.data.position.opening.end.offset)) ? "attributes"
                : depth >= 2 ? "depth" : undefined;
          if (reason) return { type: "paragraph", position: node.position, data: { detailsIssue: reason, detailsSource: raw }, children: [{ type: "text", value: raw, position: node.position }] };
          node.data = { ...node.data, detailsSource: raw };
          walk(node, depth + 1);
        } else if ("children" in node) walk(node, depth);
        return node;
      });
    };
    walk(tree, 0);
    return parsed;
  };
  // The editor keeps each directive as an opaque block, so serialization must
  // return its original source rather than regenerate delimiters or whitespace.
  (data.toMarkdownExtensions ??= []).push({ handlers: {
    containerDirective(node) { return (node as unknown as MarkdownNode).data?.detailsSource ?? ""; },
  } });
}

// Compare flow blocks, not prose words or source offsets. A closing delimiter
// moving across even one paragraph changes this sequence, as does nesting.
export function detailsShape(tree: unknown): string | null {
  let found = false;
  const flow = new Set(["root", "paragraph", "heading", "blockquote", "list", "listItem", "table", "tableRow", "tableCell", "code", "math", "thematicBreak", "html", "definition", "footnoteDefinition"]);
  const shape = (node: MarkdownNode): string => {
    if (node.type === "containerDirective") {
      found = true;
      return `details(${(node.children ?? []).filter(child => !child.data?.directiveLabel).map(shape).join(",")})`;
    }
    if (!flow.has(node.type)) return "";
    const children = node.children ? node.children.map(shape).filter(Boolean).join(",") : "";
    return `${node.type}(${children})`;
  };
  const signature = shape(tree as MarkdownNode);
  return found ? signature : null;
}
