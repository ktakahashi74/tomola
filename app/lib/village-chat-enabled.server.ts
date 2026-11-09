import { villagesEnabled } from "./villages-enabled.server";

type Env = Record<string, string | undefined>;
export function villageChatEnabled(env: Env = process.env): boolean {
  const value = env.VILLAGE_CHAT?.trim() ?? "";
  if (value !== "" && value !== "1") throw new Error("VILLAGE_CHAT must be 1 or empty (unset)");
  return villagesEnabled(env) && value === "1";
}

export function assertVillageChatConfig(env: Env): void {
  villageChatEnabled(env);
  if (env.VILLAGE_CHAT?.trim() === "1" && !villagesEnabled(env)) throw new Error("VILLAGE_CHAT requires VILLAGES=1");
}
