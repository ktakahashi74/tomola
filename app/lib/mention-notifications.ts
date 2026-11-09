export const MENTION_NOTIFY_LIMIT = 10;

// Preserve source order until the quota has been applied; callers sort database writes afterwards.
export function selectMentionRecipients(mentioned: readonly string[], authorId: string, told: ReadonlySet<string> = new Set()): string[] {
  return [...new Set(mentioned)].filter(id => id !== authorId && !told.has(id)).slice(0, Math.max(0, MENTION_NOTIFY_LIMIT - told.size));
}
