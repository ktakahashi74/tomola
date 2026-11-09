import { isDeletedIdentity } from "./deleted-member";
import { z } from "zod";
import { normalizeEmail } from "~/lib/invitations.server";

const emailSchema = z.email();

// Validate with z.email(), as Better Auth does. Null if invalid.
export function parseEmail(input: string): string | null {
  const parsed = emailSchema.safeParse(normalizeEmail(input));
  return parsed.success && !isDeletedIdentity(undefined, parsed.data) ? parsed.data : null;
}
