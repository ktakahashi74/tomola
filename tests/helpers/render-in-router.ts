import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, type RouteObject, type StaticHandlerContext } from "react-router";
import { publicOperatorSettings } from "~/lib/operator-config.server";
import { shellLabels } from "~/lib/shell-labels.server";
import { getLocale } from "~/paraglide/runtime.js";

function shellLoaderData(rootData: Record<string, unknown>) {
  return { operator: publicOperatorSettings(getLocale()), labels: shellLabels(), ...rootData };
}

export function withShellLabels(routes: RouteObject[], rootData: Record<string, unknown> = {}): RouteObject[] {
  return [{ id: "root", loader: () => shellLoaderData(rootData), children: routes }];
}

// Draws a component that uses <Form> or a fetcher (they need a data router) the way the server draws it, without JavaScript.
// path may carry a query ("/?order=activity"): the route is the path part, the request has the whole address.
export async function renderInRouter(element: () => ReactElement, path = "/", handle?: unknown, rootData: Record<string, unknown> = {}): Promise<string> {
  const routes = [{ id: "root", path: path.split("?")[0], loader: () => shellLoaderData(rootData), Component: element, handle }];
  const handler = createStaticHandler(routes);
  const context = (await handler.query(new Request(`http://localhost${path}`))) as StaticHandlerContext;
  return renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context, hydrate: false }));
}
