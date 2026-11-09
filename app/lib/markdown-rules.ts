import { gfmAutolinkLiteralFromMarkdown, gfmAutolinkLiteralToMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughFromMarkdown, gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown, gfmTableToMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown, gfmTaskListItemToMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkCjkStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";
import { urlAutolinkLiteral } from "./url-autolink";
import { urlTextAutolinks } from "./url-autolink-text";

// One grammar for saved renders, extracts, translation checks and Milkdown.
export function remarkMarkdownRules(this: Processor) {
  const data = this.data();
  const autolink = gfmAutolinkLiteralFromMarkdown();
  // Lexical tokens carry source positions. The decoded-text fallback discards
  // those positions and cannot return following text to the inline grammar.
  delete autolink.transforms;
  for (const type of ["literalAutolinkHttp", "literalAutolinkWww", "literalAutolinkEmail"] as const) {
    autolink.enter![type] = function () { this.buffer(); };
    autolink.exit![type] = function (token) {
      const decoded = this.resume();
      const raw = this.sliceSerialize(token);
      const value = (token as typeof token & { _urlDecoded?: boolean })._urlDecoded ? decoded : raw;
      this.enter({ type: "text", value }, token);
      this.exit(token);
      const link = this.stack[this.stack.length - 1];
      if (link.type !== "link") throw new Error("Autolink value outside link");
      link.url = (type === "literalAutolinkWww" ? "http://" : type === "literalAutolinkEmail" ? "mailto:" : "") + value;
    };
  }
  (data.micromarkExtensions ??= []).push(urlAutolinkLiteral(), urlTextAutolinks(), gfmFootnote(), gfmStrikethrough({ singleTilde: false }), gfmTable(), gfmTaskListItem());
  (data.fromMarkdownExtensions ??= []).push(autolink, gfmFootnoteFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown(), gfmTaskListItemFromMarkdown());
  (data.toMarkdownExtensions ??= []).push(gfmAutolinkLiteralToMarkdown(), gfmFootnoteToMarkdown(), gfmStrikethroughToMarkdown(), gfmTableToMarkdown(), gfmTaskListItemToMarkdown());
  this.use(remarkCjkFriendly).use(remarkCjkStrikethrough, { singleTilde: false });
}

export function createMarkdownProcessor() {
  // Rich editing hands all math sources back to the native Markdown field.
  return unified().use(remarkParse).use(remarkMath).use(remarkMarkdownRules);
}
