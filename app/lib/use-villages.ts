import { useRouteLoaderData } from "react-router";

export function useVillages(): boolean {
  const root = useRouteLoaderData("root") as { villages?: boolean } | null | undefined;
  return root?.villages === true;
}
