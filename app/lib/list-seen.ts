export const SEEN_POSTS_KEY = "tomola.seen-posts";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
export type ListPost = { id: number; createdAt: string };
// The newest creation time that was on screen before this viewing: frozen on the first call of a viewing, so that revalidation does not move the line. undefined: not read yet. null: first visit to this list.
export type PostsView = { before?: string | null; pending?: Promise<string | null> };

// Which posts of a list are new since the reader last looked at it. Members keep the watermark in their account; guests keep it in this browser. One watermark per list address: the newest creation time
// (the server's time, so a wrong clock does not matter) among the posts shown on its first page. A first visit marks nothing. Call only in the browser, and only for the first page of a list.
// `boundaryAfter` is the last new post in the order of the screen when some post after it is not new: the line "posts you have seen start here" goes under it.
export function rememberViewingPosts(storage: StorageAccess, scope: string, posts: readonly ListPost[], view: PostsView): { newIds: number[]; boundaryAfter: number | null } {
  const none = { newIds: [], boundaryAfter: null };
  try {
    let saved: unknown;
    try { saved = JSON.parse(storage.getItem(SEEN_POSTS_KEY) ?? "[]"); } catch { saved = []; }
    const records = new Map<string, string>();
    if (Array.isArray(saved)) for (const item of saved.slice(-50)) {
      if (Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && typeof item[1] === "string" && !Number.isNaN(Date.parse(item[1]))) records.set(item[0], item[1]);
    }
    const previous = records.get(scope) ?? null;
    if (view.before === undefined) view.before = previous;
    const newest = posts.reduce<string | null>((max, post) => max === null || post.createdAt > max ? post.createdAt : max, previous);
    records.delete(scope);
    if (newest !== null) records.set(scope, newest);
    storage.setItem(SEEN_POSTS_KEY, JSON.stringify([...records].slice(-50)));
    return postMarks(posts, view.before);
  } catch {
    return none;
  }
}

// One exchange per visit, shared by effects restarted during revalidation.
// A failed exchange stays unmarked for this visit; browser history is never an account fallback.
export async function rememberMemberViewingPosts(scope: string, posts: readonly ListPost[], view: PostsView) {
  try {
    if (!posts.length) return postMarks(posts, null);
    view.pending ??= fetch("/list-seen", {
      method: "POST", credentials: "same-origin",
      body: new URLSearchParams({ scope, seenAt: posts.reduce((max, post) => post.createdAt > max ? post.createdAt : max, posts[0].createdAt) }),
    }).then(async response => {
      if (!response.ok) throw new Error("List watermark unavailable");
      const result: unknown = await response.json();
      const previous = (result as { previous?: unknown } | null)?.previous;
      if (previous !== null && (typeof previous !== "string" || Number.isNaN(Date.parse(previous)))) throw new Error("Invalid list watermark");
      return previous;
    });
    view.before = await view.pending;
    return postMarks(posts, view.before);
  } catch {
    return postMarks(posts, null);
  }
}

function postMarks(posts: readonly ListPost[], before: string | null) {
  if (before === null) return { newIds: [], boundaryAfter: null };
  const isNew = posts.map(post => post.createdAt > before);
  const newIds = posts.filter((_, index) => isNew[index]).map(post => post.id);
  const lastNew = isNew.lastIndexOf(true);
  const boundaryAfter = lastNew >= 0 && isNew.slice(lastNew + 1).some(value => !value) ? posts[lastNew].id : null;
  return { newIds, boundaryAfter };
}
