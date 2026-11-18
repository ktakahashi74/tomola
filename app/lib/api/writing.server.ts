import { MAX_BODY_BYTES, MAX_REPLY_BODY_LENGTH, MAX_TOPIC_BODY_LENGTH } from "~/lib/body-length";
import { CONNECT_MD_PATH } from "~/lib/connect-paths";
import { markdownWritingExamples } from "~/lib/markdown-specimen";
import { MEDIA_LIMITS, MOTION_LIMITS } from "~/lib/media";
import { siteOrigin } from "~/lib/http/csrf.server";
import { WRITING_PATH } from "~/lib/writing-paths";
import { DRAFT_RESPONSE_GUIDE } from "./draft-response-guide";

const number = (value: number) => value.toLocaleString("en-US");

// Keep the current image handoff here so a future upload tool changes one section.
function imageHandoff(origin: string): string {
  return `### Upload images in the browser

There is currently no image-upload tool for AI clients through MCP or the draft API. Give your user the image files and their alt text. After creating a draft, have them open its approval URL in the browser and upload the files there. Do not invent an upload endpoint or put external image URLs in place of managed images.

On ${origin}/t/new or a draft's writing screen, use the image insertion button to choose one file at a time (or paste an image or drop a file onto the editor). The editor uploads it and inserts managed image Markdown at the cursor. A GIF or animated WebP upload creates a still poster and a motion version, inserting the linked pair. The poster is selected from a frame with content, not necessarily the first frame; the author can replace it with another uploaded still in the Markdown. Replace the default alt text with a description of the figure and, for motion, what the changes show. Keep the returned URLs; do not construct media IDs yourself.`;
}

export function writingMarkdown(origin: string = siteOrigin()): string {
  const examples = markdownWritingExamples().map(example => `### ${example.label}\n\n\`\`\`\`markdown\n${example.markdown.trim()}\n\`\`\`\``).join("\n\n");
  return `# Write for tomola with your AI

Use this guide when your user asks you to prepare a post or reply for tomola. Produce Markdown and any image files, then create a draft if your user has connected their account. The short page for people is ${origin}${WRITING_PATH}. Connection instructions: ${origin}${CONNECT_MD_PATH}.

## Writing principles

- Write in one original language. tomola supplies translations; authors cannot attach their own alternate-language editions. Preserve the intended language when importing a post.
- Publish only the user's own writing or material they have permission to publish. Retain attribution and source links where needed.
- Give every image meaningful alt text. For an animated figure, also explain what the motion demonstrates. Avoid flashing and rapid changes of brightness.
- The person reviews the draft and publishes from the browser approval screen. AI clients prepare drafts; do not publish or operate the approval screen on the person's behalf.

## Supported Markdown

Headings, bold and italic emphasis, links, ordered and unordered lists, tables, footnotes, inline and display math (\`$…$\` and \`$$…$$\`, rendered with KaTeX), fenced code blocks, block quotes, collapsible details, managed images and mentions are supported.

Use \`:::details[Heading]\` on its own line and close it with \`:::\` on its own line. Nest at most two levels, using a longer colon fence outside (for example, four outside and three inside). Use no attributes and no other container names. A malformed container is shown literally and reported as \`details_literal\`.

Use \`![description](/media/…)\` for an uploaded image. A still and motion pair uses \`[![description](still URL)](motion URL)\`. A figure plays once when it comes into view, then returns to its still; automatic playback is disabled for readers who request reduced motion. Readers can stop it or choose to play it again. With no JavaScript, the still links to the motion file.

Mention a member with \`@handle\`, using their unique username, not their display name. Mentions in code, links, email addresses and block quotes do not call members. See ${origin}/llms.txt for mention and notification rules.

Raw HTML, SVG, video and animated PNG are not supported. External images become links rather than embedded images. Convert video and interactive graphics to an informative still (optionally paired with a supported animated figure) and include a link to the original page. Custom scripts, iframes and HTML styling cannot be carried over.

## Limits

- Topic body: ${number(MAX_TOPIC_BODY_LENGTH)} units after NFC normalization; East Asian wide/fullwidth code points count as two, other code points as one. Reply body: ${number(MAX_REPLY_BODY_LENGTH)} UTF-16 units. Both also have a UTF-8 limit of ${number(MAX_BODY_BYTES)} bytes. Markdown source counts toward these limits.
- Images per post or reply: ${number(MEDIA_LIMITS.perPost)}. A still/motion pair uses two slots toward this limit. Still inputs: JPEG, PNG or WebP. Motion inputs: GIF or animated WebP.
- Each uploaded file: at most ${number(MEDIA_LIMITS.inputBytes)} bytes. A still input: at most ${number(MEDIA_LIMITS.pixels)} pixels. Stored images are resized to a longest edge of at most ${number(MEDIA_LIMITS.edge)} pixels and rewritten as WebP with embedded metadata removed. Each stored still: at most ${number(MEDIA_LIMITS.storedBytes)} bytes.
- Motion input: at most ${number(MOTION_LIMITS.width)} × ${number(MOTION_LIMITS.height)} pixels per frame, ${number(MOTION_LIMITS.frames)} frames, ${number(MOTION_LIMITS.durationMs / 1000)} seconds and ${number(MOTION_LIMITS.pixels)} total decoded pixels (width × height × frames). Each stored motion version: at most ${number(MOTION_LIMITS.storedBytes)} bytes, separately from its still poster. Files exceeding a processing or storage limit may be refused even below the other limits.

## Examples

The managed image URLs below are invented examples of the required shape. Replace them with the URLs returned by the writing screen after upload.

${examples}

## Import from another blog or HTML

| Source | tomola version |
| --- | --- |
| KaTeX or MathJax output | Recover the original TeX and put it between inline or display math delimiters. Do not copy rendered HTML. |
| HTML details/summary | Use a details container with its summary as the heading; keep nesting within two levels. |
| Footnotes and back links | Use Markdown footnote references and definitions. |
| Figure and caption | Use an uploaded image with alt text, followed by the caption as a paragraph. |
| Animated figure | Upload a supported file and use the still/motion pair. |
| Interactive figure or video | Use an informative still, optionally a supported motion pair, and a link to the original page. |
| Table of contents, navigation, page decorations | Omit them. Keep the article's own headings and content. |
| Relative links to other source pages | Resolve them to absolute URLs at the original site. |

Check the original TeX, captions, attribution, footnotes and links after conversion; a screenshot cannot replace missing mathematical source.

## Deliver the draft

### By hand

Open ${origin}/t/new, switch to Markdown mode and paste the prepared Markdown. Upload image files as described below, check the preview and the selected original language, then let the author review and publish. The same image insertion works when editing a post.

### With an AI connection or script

For MCP, follow ${origin}${CONNECT_MD_PATH} to connect the member account with draft permission. Use \`tomola_draft_create\` with \`kind: "topic"\`, optional \`title\`, \`body\` (Markdown) and \`lang\`. Replies use \`kind: "reply"\`, \`threadId\` and optional \`parentId\`. Revise the same draft with \`tomola_draft_update\` and its \`id\`. These tools can access only drafts owned by that authenticated client. Give the author the returned \`approvalUrl\`.

For HTTP, send \`POST ${origin}/api/drafts\` with a draft Bearer token and \`Content-Type: text/markdown\`; the body is Markdown with optional YAML frontmatter (for example \`type: topic\`, \`title\` and \`lang\`). A reply needs \`reply_to: p-<topic id>\` or \`reply_to: c-<reply id>\`. The response returns \`approve_url\`. Token setup, request examples, optional fields and errors: ${origin}/help/ai.md. Schema: ${origin}/api/openapi.json. Keep tokens out of the post and conversation.

### Read the draft diagnostics

${DRAFT_RESPONSE_GUIDE}

${imageHandoff(origin)}
`;
}
