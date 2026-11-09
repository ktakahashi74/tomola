// Following a topic (threads and questions; never members). Used by the browser and the server; the DB CHECK constraint is made from this list
// (app/lib/db/schema.ts). `unfollowed` rows are kept so that a topic the member took off is never followed again automatically.
export const FOLLOW_STATES = ["following", "unfollowed"] as const;
export type FollowState = (typeof FOLLOW_STATES)[number];
export const isFollowState = (x: unknown): x is FollowState => typeof x === "string" && (FOLLOW_STATES as readonly string[]).includes(x);
