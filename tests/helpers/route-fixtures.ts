import { createElement, type ComponentType } from "react";
import type { Location } from "react-router";
import type { Route as RootRoute } from "../../app/+types/root";

export function routeElement<LoaderData, ActionData, Params extends object, Matches extends readonly unknown[]>(
  Component: ComponentType<{ loaderData: LoaderData; actionData?: ActionData; params: Params; matches: Matches }>,
  { loaderData, actionData, params = {} }: {
    loaderData: NoInfer<LoaderData>;
    actionData?: NoInfer<ActionData>;
    params?: Partial<NoInfer<Params>>;
  },
) {
  // The test routers provide their own context. Framework components used here read the supplied data props.
  const matches: readonly unknown[] = [];
  return createElement(Component, { loaderData, actionData, params: params as Params, matches: matches as Matches });
}

export function routeMeta<LoaderData, Params extends object, Matches extends readonly unknown[], Result>(
  meta: (args: { loaderData: LoaderData; location: Location; params: Params; matches: Matches }) => Result,
  { loaderData, location, rootData }: {
    loaderData: NoInfer<LoaderData>;
    location?: Partial<Location>;
    rootData?: Partial<RootRoute.ComponentProps["loaderData"]>;
  },
): Result {
  // Metadata tests use a synthetic location and only supply the root match when it affects the tags.
  const matches: readonly unknown[] = rootData ? [{ id: "root", loaderData: rootData }] : [];
  return meta({
    loaderData,
    location: { pathname: "/", search: "", hash: "", key: "default", state: null, ...location },
    matches: matches as Matches,
    params: {} as Params,
  });
}

// Bind the loader to its component before collecting cases for different routes.
export async function loadRouteElement<LoaderData, ActionData, Params extends object, Matches extends readonly unknown[]>(
  Component: ComponentType<{ loaderData: LoaderData; actionData?: ActionData; params: Params; matches: Matches }>,
  load: () => Promise<NoInfer<LoaderData>>,
) {
  const loaderData = await load();
  return { loaderData, element: routeElement(Component, { loaderData }) };
}
