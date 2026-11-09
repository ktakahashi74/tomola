import { Outlet } from "react-router";
import type { Route } from "./+types/member-content";
import { RouteError } from "~/components/route-error";

// Catch child-page failures inside the authenticated header, leaving its loader and navigation intact.
export default function MemberContent() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError error={error} showSite={false} />;
}
