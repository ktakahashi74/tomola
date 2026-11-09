// A "long post" is a topic with a title (a topic without a title is a short remark). The title is the only thing that tells them apart, and the database keeps
// it that way (entries_title_not_blank_check, entries_reply_title_check: a title is never blank, and only a topic has one). The home uses this for its "long posts only" filter.
// The SQL side is `titledOnly` of listTopics (app/lib/entries.server.ts), which means the same thing.
export function isLongPost(entry: { kind?: string; title: string | null }): boolean {
  return (entry.kind === undefined || entry.kind === "topic") && entry.title !== null;
}
