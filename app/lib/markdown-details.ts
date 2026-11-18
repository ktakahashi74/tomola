import { directiveFromMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";
import type { Processor } from "unified";

export type DetailsIssueReason = "name" | "unclosed" | "attributes" | "depth" | "summary_footnote";

type Position = { start: { offset?: number; line: number; column?: number }; end: { offset?: number } };

export type MarkdownNode = {
  type: string;
  name?: string;
  value?: string;
  alt?: string | null;
  label?: string | null;
  identifier?: string;
  attributes?: Record<string, unknown> | null;
  children?: MarkdownNode[];
  position?: Position;
  data?: {
    detailsSource?: string;
    detailsIssue?: DetailsIssueReason;
    directiveLabel?: boolean;
    position?: { opening: Position; closing?: Position };
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
          node.data = { ...node.data, detailsSource: raw, detailsIssue: reason };
          if (reason) {
            // Retain the source wrapper for rich editing, but render only the
            // delimiters literally and keep the parsed body blocks intact.
            const literal = (position: Position): MarkdownNode => ({ type: "paragraph", position, children: [{ type: "text", value: source.slice(position.start.offset, position.end.offset), position }] });
            const { opening, closing } = node.data.position!;
            node.children = [literal(opening), ...(node.children ?? []).filter(child => !child.data?.directiveLabel), ...(closing ? [literal(closing)] : [])];
          } else {
            const inspectLabel = (child: MarkdownNode) => {
              if (child.type === "footnoteReference") child.data = { ...child.data, detailsIssue: "summary_footnote" };
              child.children?.forEach(inspectLabel);
            };
            node.children?.filter(child => child.data?.directiveLabel).forEach(inspectLabel);
          }
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
      if (node.data?.detailsIssue) return (node.children ?? []).map(shape).join(",");
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
