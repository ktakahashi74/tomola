import { createHmac, timingSafeEqual } from "node:crypto";
import { authSecret } from "./auth/secret.server";
import type { Draft } from "./drafts.server";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { drafts } from "./db/schema";

// The original row may be gone by the time the member chooses recovery. Preserve
// its immutable context without trusting editable form fields or granting its API
// client access to the new web draft. Text and current posting choices stay editable.
type Context = Pick<Draft, "kind" | "threadId" | "parentId" | "altOf" | "responseTo" | "aiAssistance" | "clientId" | "clientName" | "clientUri"> & { clientUpdatedAt: string | null };
export async function draftRecoveryToken(db: Db, userId: string, draft: Draft): Promise<string> {
  let clientId = draft.clientId;
  if (clientId === null && draft.via === "api") {
    const [row] = await db.select({ tokenId: drafts.tokenId }).from(drafts).where(and(eq(drafts.id, draft.id), eq(drafts.authorId, userId)));
    clientId = `token:${row?.tokenId ?? "deleted"}`;
  }
  const context: Context = {
    kind: draft.kind, threadId: draft.threadId, parentId: draft.parentId, altOf: draft.altOf, responseTo: draft.responseTo, aiAssistance: draft.aiAssistance,
    clientId,
    clientName: draft.clientName ?? draft.tokenName, clientUri: draft.clientUri,
    clientUpdatedAt: (draft.clientUpdatedAt ?? (draft.via === "api" ? draft.updatedAt : null))?.toISOString() ?? null,
  };
  const text = Buffer.from(JSON.stringify({ userId, context, issuedAt: Date.now() })).toString("base64url");
  return `${text}.${createHmac("sha256", authSecret()).update(`draft-recovery:${text}`).digest("base64url")}`;
}

export function readDraftRecoveryToken(userId: string, token: string): Context | null {
  const [text, mac, extra] = token.split(".");
  if (!text || !mac || extra || token.length > 8192) return null;
  const expected = createHmac("sha256", authSecret()).update(`draft-recovery:${text}`).digest();
  const actual = Buffer.from(mac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (!Number.isSafeInteger(payload.issuedAt) || payload.issuedAt > Date.now() || Date.now() - payload.issuedAt > 24 * 60 * 60 * 1000) return null;
    return payload.userId === userId ? payload.context : null;
  } catch { return null; }
}
