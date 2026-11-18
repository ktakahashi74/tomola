import { MEDIA_LIMITS } from "~/lib/media";

export function mediaUploadGuide(origin: string): string {
  return `### Upload images before writing a draft

With your user's permission, send one local image to POST ${origin}/api/media. Use a draft token created at ${origin}/settings/tokens with “Upload images” explicitly selected, or an OAuth access token with the separately granted media scope (resource ${origin}/mcp). For OAuth, request media in addition to draft only when image uploads are needed; the member explicitly selects “Upload images” at consent. Existing read/draft credentials do not gain this permission. Cookies and URL tokens are ignored. Uploads use account storage and upload allowances and do not publish anything.

Send the image bytes with Content-Type: application/octet-stream (or image/*), or multipart/form-data with exactly one file part (for example, image). Maximum image size: ${MEDIA_LIMITS.inputBytes} bytes. Multipart headers are limited to 8192 bytes and 16 lines. The image is identified and rewritten from its contents; its original filename is not stored.

Example: curl -X POST '${origin}/api/media' -H 'Authorization: Bearer <token>' -H 'Content-Type: application/octet-stream' --data-binary @diagram.png

201 returns JSON: { mediaId, url, width, height, posterUrl?, posterWidth?, posterHeight?, markdown }. URLs are site-relative. A motion image returns both the animated URL and its still poster URL. The markdown field is a starting example: replace “Describe the image” with a useful description. Still: ![description](url). Motion: [![description](posterUrl)](url).

Use those URLs in the body of a draft, created through POST /api/drafts (a draft PAT) or tomola_draft_create (OAuth draft scope). Give your user the returned approvalUrl (REST also calls it approve_url) to review and publish in the browser. A draft-only image remains readable only by its owner. MCP does not import image URLs; this endpoint receives files only.

The shared member allowance is ${MEDIA_LIMITS.hourly} images/hour across browser and API; API uploads additionally have ${MEDIA_LIMITS.apiHourly}/hour per member across all credentials. A motion/still pair costs two. Failed attempts count; receive/decoder admission refusals do not. Storage limits: ${MEDIA_LIMITS.storedCount} images/member, ${MEDIA_LIMITS.memberStoredBytes} bytes/member and ${MEDIA_LIMITS.siteStoredBytes} bytes/site.

Errors use { error, message }: unauthorized (401), forbidden (403, missing permission or unavailable writing), too_large (413), type or generic (400), rate (429, Retry-After and X-RateLimit-*), quota/member_bytes/site_bytes (409), busy (503, Retry-After). Other processing failures may return generic with 408 or 500. Re-uploading the same image returns the same result while that stored image remains active.
`;
}
