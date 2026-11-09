// Browser form submission sends textarea newlines as CRLF (other paths, such as the API, use LF).
// Normalize Web form titles and bodies to LF before saving so sentence boundaries and source-version comparisons do not vary by submission path.
// This normalizes transport differences, not source content; leave other whitespace and characters unchanged.
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

// A title that is empty or only whitespace means "no title": null, never an empty string. A title with text is returned as it is.
export function titleOrNull(title: string | null | undefined): string | null {
  return title == null || title.trim() === "" ? null : title;
}

// Whether a typed or pasted body begins with a frontmatter block ("---" on the first line). A form can be told that the title may still come from it: the server reads a pasted
// frontmatter when the post is sent, so the browser must not insist on the title field being filled in (the server answers invalid_title if there is no title anywhere).
export function startsWithFrontmatter(text: string): boolean {
  return /^\s*---[ \t]*\r?\n/.test(text);
}
