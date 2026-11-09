import { Link } from "react-router";
import { safeSettingsReturnPath } from "~/lib/settings-return";
import { m } from "~/paraglide/messages.js";

export function SettingsReturnLink({ to }: { to?: string | null }) {
  const path = safeSettingsReturnPath(to);
  return path ? <Link to={path} className="ms-2 underline">{m.settings_return()}</Link> : null;
}
