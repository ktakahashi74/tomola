import { useRouteLoaderData } from "react-router";
import { LANGS, type Lang } from "~/lib/languages";

// The enabled languages for components (the root loader returns them). Falls back to all languages where the root data is not available (an error screen).
export function useEnabledLangs(): readonly Lang[] {
  const root = useRouteLoaderData("root") as { enabledLangs?: readonly Lang[] } | null | undefined;
  return root?.enabledLangs ?? LANGS;
}
