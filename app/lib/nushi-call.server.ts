import { frozenMentionKey, matchMentions, mentionSpellings } from "./mentions-md.server";

// Exact reserved spellings use the existing Markdown parser. Its frozen targets
// suppress prefix matching, escaped sigils, quotes, code, links and raw HTML.
export async function callsNushi(body: string): Promise<boolean> {
  const targets = new Map((await mentionSpellings(body)).map(spelling => {
    const key = spelling.normalize("NFKC").toLowerCase();
    const handle = key.slice(1), valid = ["nushi", "village-ai"].includes(handle);
    return [frozenMentionKey(spelling), { handle, userId: valid ? "nushi-syntax" : "", prefix: valid ? spelling.slice(1) : null }];
  }));
  return (await matchMentions(body, targets)).some(match => !match.quoted);
}
