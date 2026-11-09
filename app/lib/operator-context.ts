import { createContext, useContext } from "react";
import { useRouteLoaderData } from "react-router";
import type { PublicOperatorSettings } from "./operator-settings";

// The document entry supplies the same settings even when the root loader fails.
export const OperatorSettingsContext = createContext<PublicOperatorSettings | null>(null);
export function useOperatorSettings(): PublicOperatorSettings {
  const root = useRouteLoaderData("root") as { operator?: PublicOperatorSettings } | undefined;
  const fallback = useContext(OperatorSettingsContext);
  const settings = root?.operator ?? fallback;
  if (!settings) throw new Error("Operator settings were not supplied to the document");
  return settings;
}
