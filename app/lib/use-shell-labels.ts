import { useRouteLoaderData } from "react-router";
import type { ShellLabels } from "./shell-labels";

// Public documents and personalized headers use the same server-selected locale.
export function useShellLabels(): ShellLabels {
  const root = useRouteLoaderData("root") as { labels: ShellLabels } | undefined;
  if (!root) throw new Error("Page shell labels require the root loader");
  return root.labels;
}
