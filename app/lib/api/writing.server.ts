import { MAX_BODY_BYTES, MAX_REPLY_BODY_LENGTH, MAX_TOPIC_BODY_LENGTH } from "~/lib/body-length";
import { CONNECT_MD_PATH } from "~/lib/connect-paths";
import { markdownWritingExamples } from "~/lib/markdown-specimen";
import { MEDIA_LIMITS, MOTION_LIMITS } from "~/lib/media";
import { siteOrigin } from "~/lib/http/csrf.server";
import { WRITING_PATH } from "~/lib/writing-paths";
import { DRAFT_RESPONSE_GUIDE } from "./draft-response-guide";
import { mediaUploadGuide } from "./media-guide.server";

const number = (value: number) => value.toLocaleString("en-US");

function imageHandoff(origin: string): string {
  // Display widths approximate --reading-latin-measure, --reading-cjk-measure, and --reading-figure-max in app/app.css.
  return `### Images for topics

Images are supported only in topics, not replies. Replies have no image-upload control; prepare text replies and put any needed figures in a topic or link to them.

### Prepare figures for reading

- **Display width.** On wide screens, the reading column is about 650 CSS px for English and similar languages, and about 700 CSS px for Japanese, Chinese, and Korean. A wider image placed alone in its own paragraph can extend to about 765 CSS px and shrinks on narrower screens; put the caption in the next paragraph. On phones they fit the reading column, typically about 340–360 CSS px. Figures have no click-to-enlarge control, so make them readable at these sizes.
- **Label size.** Aim for a font size of at least 14 CSS px when the figure is displayed at about 700 CSS px wide. For an export W px wide, use a font size of at least W × 14 ÷ 700 px (32 px for a 1,600 px export). On phones, text will be about half as large. Split a dense figure into several figures or move some text into the article or caption.
- **Export format and size.** Use PNG for diagrams and other figures with fine lines or text, and JPEG or WebP for photos. Aim for a width of ${number(Math.round(MEDIA_LIMITS.edge * 0.7))}–${number(MEDIA_LIMITS.edge)} px, about twice the display width. tomola resizes still images to a longest edge of at most ${number(MEDIA_LIMITS.edge)} px and stores them as WebP, so larger exports add no resolution to the stored image.
- **Editable source.** If the original Figma file, Keynote deck, or notebook is public, add a regular link to it in the caption or at the end of the article. Embedding it would make readers' browsers contact an external site, let later edits change the published figure, and bypass translation of text inside the figure.

${mediaUploadGuide(origin)}
### When your AI cannot upload images

If you cannot send image files, for example from a chat-only AI, give your user the image files and their alt text. Images can also be uploaded on topic writing screens: a new topic, a topic draft or a topic edit. After creating a topic draft, have them open its approval URL in the browser and upload the files there. Do not invent an upload endpoint or put external image URLs in place of managed images.

On ${origin}/t/new, a topic draft's writing screen or a topic edit screen, use the image insertion button to choose one file at a time (or paste an image or drop a file onto the editor). The editor uploads it and inserts managed image Markdown at the cursor. A GIF or animated WebP upload creates a still poster and a motion version, inserting the linked pair. The poster is selected from a frame with content, not necessarily the first frame; the author can replace it with another uploaded still in the Markdown. Replace the default alt text with a description of the figure and, for motion, what the changes show. Keep the returned URLs; do not construct media IDs yourself.

Before revising a draft after the author adds images or edits in the browser, call \`tomola_draft_get\` with its \`id\` and build the revision from the current body, preserving image Markdown, alt text and the author's changes. Send the revised body with \`tomola_draft_update\` and set \`expectedVersion\` to the version you read. If the version changed, read the draft again before proposing a revision. For HTTP-created drafts, have the author reopen the current draft in the browser and revise that body there.`;
}

export function writingMarkdown(origin: string = siteOrigin()): string {
  const examples = markdownWritingExamples().map(example => `### ${example.label}\n\n\`\`\`\`markdown\n${example.markdown.trim()}\n\`\`\`\``).join("\n\n");
  return `# Write for tomola with your AI

Use this guide when your user asks you to prepare a topic or reply for tomola. Produce Markdown, with any image files for topics, then create a draft if your user has connected their account. The short page for people is ${origin}${WRITING_PATH}. Connection instructions: ${origin}${CONNECT_MD_PATH}.

## Writing principles

- Write in one original language. tomola supplies translations; authors cannot attach their own alternate-language editions. Preserve the intended language when importing a post.
- Publish only the user's own writing or material they have permission to publish. Retain attribution and source links where needed.
- Give every image meaningful alt text. For an animated figure, also explain what the motion demonstrates. Avoid flashing and rapid changes of brightness.
- The person reviews the draft and publishes from the browser approval screen. AI clients prepare drafts; do not publish or operate the approval screen on the person's behalf.

## Supported Markdown

Headings, bold and italic emphasis, links, ordered and unordered lists, tables, footnotes, inline and display math (\`$…$\` and \`$$…$$\`, rendered with KaTeX), fenced code blocks, block quotes, collapsible details, managed images and mentions are supported.

Use \`:::details[Heading]\` on its own line and close it with \`:::\` on its own line. Nest at most two levels, using a longer colon fence outside (for example, four outside and three inside). Use no attributes and no other container names. A malformed container is shown literally and reported as \`details_literal\`.

Use \`![description](/media/…)\` for an uploaded image. A still and motion pair uses \`[![description](still URL)](motion URL)\`. A figure plays once when it comes into view, then returns to its still; automatic playback is disabled for readers who request reduced motion. Readers can stop it or choose to play it again. With no JavaScript, a link below the still opens the motion version.

Mention a member with \`@handle\`, using their unique username, not their display name. Mentions in code, links, email addresses and block quotes do not call members. See ${origin}/llms.txt for mention and notification rules.

Raw HTML, SVG, video and animated PNG are not supported. External images become links rather than embedded images. Convert video and interactive graphics to an informative still (optionally paired with a supported animated figure) and include a link to the original page. Custom scripts, iframes and HTML styling cannot be carried over.

## Limits

- Topic body: ${number(MAX_TOPIC_BODY_LENGTH)} units after NFC normalization; East Asian wide/fullwidth code points count as two, other code points as one. Reply body: ${number(MAX_REPLY_BODY_LENGTH)} UTF-16 units. Both also have a UTF-8 limit of ${number(MAX_BODY_BYTES)} bytes. Markdown source counts toward these limits.
- Displayed images per topic: at most ${number(MEDIA_LIMITS.perPost)}. Excess images do not reject the draft or post; they become alt text (which may link to the image). A still/motion pair uses two slots toward this display limit. Upload controls are available only for topics, as described below. Still inputs: JPEG, PNG or WebP. Motion inputs: GIF or animated WebP.
- Each uploaded file: at most ${number(MEDIA_LIMITS.inputBytes)} bytes. A still input: at most ${number(MEDIA_LIMITS.pixels)} pixels. Stored images are resized to a longest edge of at most ${number(MEDIA_LIMITS.edge)} pixels and rewritten as WebP with embedded metadata removed. Each stored still: at most ${number(MEDIA_LIMITS.storedBytes)} bytes.
- Motion input: at most ${number(MOTION_LIMITS.width)} × ${number(MOTION_LIMITS.height)} pixels per frame, ${number(MOTION_LIMITS.frames)} frames, ${number(MOTION_LIMITS.durationMs / 1000)} seconds and ${number(MOTION_LIMITS.pixels)} total decoded pixels (width × height × frames). Each stored motion version: at most ${number(MOTION_LIMITS.storedBytes)} bytes, separately from its still poster. Files exceeding a processing or storage limit may be refused even below the other limits.

## Examples

The managed image URLs below are invented examples of the required shape. Replace them with the URLs returned by the image upload API or the writing screen after upload.

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

Open ${origin}/t/new, switch to Markdown mode and paste the prepared Markdown. Upload image files as described below, check the preview and the selected original language, then let the author review and publish. The same image insertion works when editing a topic.

### With an AI connection or script

For MCP, follow ${origin}${CONNECT_MD_PATH} to connect the member account with draft permission. Use \`tomola_draft_create\` with \`kind: "topic"\`, optional \`title\`, \`body\` (Markdown) and \`lang\`. Replies use \`kind: "reply"\`, \`threadId\` and optional \`parentId\`. Give each intended draft a unique \`requestId\` and repeat the same arguments on retry. Before every revision, call \`tomola_draft_get\` with its \`id\`, read the current body and preserve the author's image Markdown and edits. Send the revised body with \`tomola_draft_update\`, the same \`id\`, and \`expectedVersion\` from the read. These tools can access only drafts owned by that authenticated client. Give the author the returned \`approvalUrl\`. Use \`tomola_draft_status\` to check whether they published or discarded the draft.

For HTTP, send \`POST ${origin}/api/drafts\` with a draft Bearer token and \`Content-Type: text/markdown\`; the body is Markdown with optional YAML frontmatter (for example \`type: topic\`, \`title\` and \`lang\`). A reply needs \`reply_to: p-<topic id>\` or \`reply_to: c-<reply id>\`. The response returns \`approve_url\`. This API creates drafts only; to revise one, have the author reopen it in the browser, read its current body and apply changes to that body, preserving images and edits. Token setup, request examples, optional fields and errors: ${origin}/help/ai.md. Schema: ${origin}/api/openapi.json. Keep tokens out of the post and conversation.

### Read the draft diagnostics

${DRAFT_RESPONSE_GUIDE}

${imageHandoff(origin)}
`;
}
