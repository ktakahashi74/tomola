export type ReplyParent = { id: number; parentId: number | null };
export type ReplyBranch = { rootId: number; replyIds: number[] };

// The input page is already sliced in createdAt/id order. Group only that page;
// neither pagination nor the chronological sequence used by other surfaces changes.
export function buildReplyBranches(topicId: number, replies: readonly { id: number }[], parents: readonly ReplyParent[], flat = false): ReplyBranch[] {
  if (flat) return replies.map(reply => ({ rootId: reply.id, replyIds: [reply.id] }));
  const byId = new Map(parents.map(reply => [reply.id, reply.parentId]));
  // null denotes an invalid chain. Every reply reaching it remains its own root.
  const resolved = new Map<number, number | null>();
  function rootOf(id: number): number {
    const path: number[] = [];
    const visiting = new Set<number>();
    let current = id;
    let root: number | null = null;
    for (;;) {
      if (resolved.has(current)) { root = resolved.get(current)!; break; }
      if (!byId.has(current) || visiting.has(current) || path.length > byId.size) break;
      visiting.add(current);
      path.push(current);
      const parent = byId.get(current)!;
      if (parent === null || parent === topicId) { root = current; break; }
      current = parent;
    }
    for (const member of path) resolved.set(member, root);
    return root ?? id;
  }
  const branches = new Map<number, ReplyBranch>();
  for (const reply of replies) {
    const rootId = rootOf(reply.id);
    let branch = branches.get(rootId);
    if (!branch) { branch = { rootId, replyIds: [] }; branches.set(rootId, branch); }
    branch.replyIds.push(reply.id);
  }
  return [...branches.values()];
}

export const BRANCH_COLLAPSE_AFTER = 5;
export const BRANCH_PREVIEW_REPLIES = 3;

// The head is always outside <details>, including a placeholder or continuation.
export function splitReplyBranch(ids: readonly number[]) {
  const children = ids.slice(1);
  return children.length > BRANCH_COLLAPSE_AFTER
    ? { shown: children.slice(0, BRANCH_PREVIEW_REPLIES), folded: children.slice(BRANCH_PREVIEW_REPLIES) }
    : { shown: children, folded: [] };
}
