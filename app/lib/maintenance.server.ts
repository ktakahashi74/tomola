import type { MiddlewareFunction } from "react-router";
import { maintenanceActive } from "../../server/maintenance";
import { negotiateUiLocale } from "./http/locale.server";
import { enabledLangs } from "./enabled-langs.server";
import { m } from "~/paraglide/messages.js";
export const MAINTENANCE_RETRY_AFTER_SECONDS = 30;

export function maintenanceResponse(request: Request, env: Record<string, string | undefined> = process.env): Response | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || !maintenanceActive(env)) return null;
  const { locale } = negotiateUiLocale(request, enabledLangs(env));
  return Response.json({ error: "maintenance_readonly", message: m.maintenance_readonly({}, { locale }) }, {
    status: 503, headers: { "Retry-After": String(MAINTENANCE_RETRY_AFTER_SECONDS), "Cache-Control": "no-store" },
  });
}
export const maintenanceMiddleware: MiddlewareFunction = async ({ request }, next) => {
  const response = maintenanceResponse(request);
  if (response) throw response;
  return next();
};
