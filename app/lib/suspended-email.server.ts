import { createHmac } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { suspendedEmailHashes } from "./db/schema";
import { authSecret } from "./auth/secret.server";

export const suspendedEmailHash = (email: string) => createHmac("sha256", authSecret())
  .update(`deleted-suspension:${email.trim().toLowerCase()}`).digest("hex");

export async function isSuspendedDeletedAddress(db: Db, email: string, now = new Date()): Promise<boolean> {
  const [row] = await db.select({ hash: suspendedEmailHashes.hash }).from(suspendedEmailHashes)
    .where(and(eq(suspendedEmailHashes.hash, suspendedEmailHash(email)), gt(suspendedEmailHashes.expiresAt, now)));
  return !!row;
}
