// Whether a list is one where "created after the newest post seen" means new: the first page, in the newest-first order, with no filter. In another order a post that is not new can stand above one that is, and
// a filtered list shows only some posts, so the newest time it showed says nothing about the posts it left out. Such lists neither mark nor record.
export function tracksNewPosts(list: { page: number; order: string; filtered: boolean }): boolean {
  return list.page === 1 && list.order === "created" && !list.filtered;
}
