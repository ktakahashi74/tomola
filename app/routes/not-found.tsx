import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { data } from "react-router";

// A matched catch-all runs the root locale and security middleware before rendering the localized error screen.
function loaderImplementation() {
  throw data("Not found", { status: 404 });
}

export function action() {
  throw data("Not found", { status: 404 });
}

export default function NotFound() {
  return null;
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
