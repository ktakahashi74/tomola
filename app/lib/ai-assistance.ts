export const AI_ASSISTANCE = ["none", "polish", "draft", "coauthor"] as const;
export type AiAssistance = (typeof AI_ASSISTANCE)[number];
