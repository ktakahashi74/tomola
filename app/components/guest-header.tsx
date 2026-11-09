import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { navigationSection } from "~/lib/navigation";
import { LocaleSwitcher } from "./locale-switcher";
import { useVillages } from "~/lib/use-villages";
import { useShellLabels } from "~/lib/use-shell-labels";

export function GuestHeader({ loginHref, children, sizing = false }: { loginHref?: string; children?: ReactNode; sizing?: boolean }) {
  const labels = useShellLabels();
  const villages = useVillages();
  const pathname = useLocation().pathname.replace(/\/$/, "") || "/";
  const current = navigationSection(pathname);
  const Tag = sizing ? "div" : "header";
  return <Tag aria-hidden={sizing || undefined} inert={sizing || undefined} className={`${sizing ? "invisible " : ""}site-header guest-header [grid-area:1/1] mb-6 border-b pb-3`}>
    <Link to="/" aria-current={current === "home" && "page"} className="logo"><span aria-hidden /><span>{labels.site_name}</span></Link>
    <nav className="guest-header-links text-sm">
      {villages && <Link to="/villages" aria-current={current === "villages" ? "page" : undefined} className="link-ui">{labels.villages_title}</Link>}
      <Link to="/why" aria-current={pathname === "/why" ? "page" : undefined} className="link-ui">{labels.footer_why}</Link>
      <Link to="/principles" aria-current={pathname === "/principles" ? "page" : undefined} className="link-ui">{labels.footer_principles}</Link>
    </nav>
    <div className="guest-header-account flex items-center gap-3 text-sm">
      <LocaleSwitcher globe clearReadingLanguage />
      {loginHref && <Link to={loginHref} className="link-ui inline-flex min-h-8 items-center whitespace-nowrap">{labels.login_title}</Link>}
      {children}
    </div>
    <p className="site-tagline">{labels.site_tagline}</p>
  </Tag>;
}
