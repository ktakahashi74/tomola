import { createHash } from "node:crypto";

// Access tokens last this long (seconds). Also the time a revoked line stays on the revocation list: no token of the line can outlive it.
export const MCP_ACCESS_TOKEN_SECONDS = 900;

// An OAuth "line" is one authorization and the refresh tokens rotated from it (they share one authorization code id). Access tokens are
// self-contained, so they carry a mark of their line: a value derived from the code id that means nothing elsewhere and cannot be turned back into it.
export function lineMark(authorizationCodeId: string): string {
  return createHash("sha256").update(`tomola-line:${authorizationCodeId}`, "utf8").digest("base64url").slice(0, 22);
}

// Id of the row in the revocation list that stops every access token of a line.
export const revokedLineId = (mark: string) => `line:${mark}`;
