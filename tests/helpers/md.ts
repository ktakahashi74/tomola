import { parse } from "yaml";
import type { RouteHarness } from "./route-harness";

// Split Markdown responses into frontmatter blocks and bodies. Files contain blank-line-separated blocks fenced by ---;
// body lines consisting only of --- have already been rewritten, so counting fence lines suffices.
export type MdBlock = { fm: Record<string, unknown>; body: string };

export function parseBlocks(text: string): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === "") {
      i++;
      continue;
    }
    if (lines[i] !== "---") throw new Error(`expected a frontmatter fence at line ${i + 1}: ${JSON.stringify(lines[i])}`);
    const end = lines.indexOf("---", i + 1);
    if (end < 0) throw new Error("unterminated frontmatter");
    const fm = parse(lines.slice(i + 1, end).join("\n"), { schema: "core" }) as Record<string, unknown>;
    let next = lines.indexOf("---", end + 1);
    if (next < 0) next = lines.length;
    blocks.push({ fm, body: lines.slice(end + 1, next).join("\n").trim() });
    i = next;
  }
  return blocks;
}

// A thread file of a readable topic starts with an overview block (type: index, replies_readable). Thread tests that look at the posts and the final paging block
// use this to read the file without it; the overview has its own tests. By default the overview must be there, so that a regression that drops it is not passed
// over silently. Pass "none" for a topic that is hidden (its file has no overview) and "any" when the file may or may not be a thread.
export const isOverviewBlock = (b: MdBlock): boolean => b.fm.type === "index" && "replies_readable" in b.fm;
export function parseThreadBlocks(text: string, overview: "required" | "none" | "any" = "required"): MdBlock[] {
  const blocks = parseBlocks(text);
  const has = blocks.length > 0 && isOverviewBlock(blocks[0]);
  if (overview === "required" && !has) throw new Error("the thread file has no overview block");
  if (overview === "none" && has) throw new Error("the file has an overview block");
  return has ? blocks.slice(1) : blocks;
}

// Count --- fence lines: twice the block count if bodies and titles have not forged fences.
export const fenceCount = (text: string) => text.split(/[\n\r\v\f\x1c-\x1e\u0085\u2028\u2029]/).filter((l) => /^(?:-{3,}|\.\.\.)[\s\x1f]*$/.test(l)).length;

// Call Markdown entrypoints directly in place of React Router routing.
export async function getMd(h: RouteHarness, path: string, opts: { as?: string; headers?: Record<string, string>; method?: string } = {}): Promise<Response> {
  const { threadMdMiddleware, areaMdMiddleware } = await import("~/lib/md/twin.server");
  const url = new URL(path, "http://localhost:5173");
  const request = h.request(`${url.pathname}${url.search}`, { as: opts.as, headers: opts.headers });
  const req = opts.method ? new Request(request, { method: opts.method }) : request;
  const next = async () => {
    throw new Error("the page route ran instead of the Markdown twin");
  };
  let m: RegExpExecArray | null;
  // Question distributions: /t/<id>/stances.md and .txt.
  if ((m = /^\/t\/([^/]+)\/stances\.(md|txt)$/.exec(url.pathname))) return (await (await import("~/routes/stances-md")).loader(h.args(req, { id: m[1] }))) as Awaited<Promise<Response>>;
  if ((m = /^\/t\/([^/]+)$/.exec(url.pathname))) return threadMdMiddleware({ request: req, params: { id: m[1] } }, next);
  if ((m = /^\/a\/([^/]+)$/.exec(url.pathname))) return areaMdMiddleware({ request: req, params: { lang: m[1] } }, next);
  if (/^\/latest\.(md|txt)$/.test(url.pathname)) return (await (await import("~/routes/latest-md")).loader(h.args(req))) as Awaited<Promise<Response>>;
  if (/^\/search\.(md|txt)$/.test(url.pathname)) return (await (await import("~/routes/search-md")).loader(h.args(req))) as Awaited<Promise<Response>>;
  if (/^\/home\.(md|txt)$/.test(url.pathname)) return (await (await import("~/routes/home-md")).loader(h.args(req))) as Awaited<Promise<Response>>;
  throw new Error(`no Markdown twin for ${url.pathname}`);
}
