import { Link } from "react-router";
import { m } from "~/paraglide/messages.js";
import type { ShellLabels } from "~/lib/shell-labels";

// Revision values have already been validated by the root loader.
// The footer of every page (rendered by the root Layout, so it also appears on the login page and on the error pages): a link to the principles page, a link to why the site was started, a link to how to connect an AI tool, /stats when readable, and, when the operator has
// set SOURCE_URL, a link to the source code (AGPL-3.0-or-later). Preview languages also show their review notice; it carries no member data.
// When the privacy notice is available, an operator link points to its operator section.
// Fixed labels come from the server. Keep the existing message fallbacks for
// an error before the root loader, including any surviving member navigation.
export function SiteFooter({ labels, sourceUrl, previewNotice = null, member = false, publicReading = false, privacyLabel = null, statsLabel = null, revision = "unknown" }: { labels: ShellLabels | undefined; sourceUrl: string | null; previewNotice?: string | null; member?: boolean; publicReading?: boolean; privacyLabel?: string | null; statsLabel?: string | null; revision?: string }) {
  return (
    <footer data-member-links={member ? "" : undefined} className={`mt-10 flex flex-wrap ${member ? "gap-x-1 gap-y-2 sm:gap-4" : "gap-4"} border-t pt-3 ui-meta text-muted-foreground`}>
      {previewNotice && <p className="w-full ui-help" role="note">{previewNotice}</p>}
      {member && <>
        <Link to="/glossary" className="underline">{labels?.nav_glossary ?? m.nav_glossary()}</Link>
        <Link to="/moderation" className="underline">{labels?.nav_moderation_log ?? m.nav_moderation_log()}</Link>
      </>}
      <Link to="/principles" className="underline">
        {labels?.footer_principles ?? m.footer_principles()}
      </Link>
      <Link to="/why" className="underline">
        {labels?.footer_why ?? m.footer_why()}
      </Link>
      {statsLabel && (member || publicReading) && <Link to="/stats" className="underline">{statsLabel}</Link>}
      <Link to="/connect" className="underline">
        {labels?.footer_connect ?? m.footer_connect()}
      </Link>
      {privacyLabel && <Link to="/privacy" className="underline">{privacyLabel}</Link>}
      {sourceUrl && (
        <a href={sourceUrl} rel="noopener noreferrer" className="underline">
          {labels?.footer_source ?? m.footer_source()}
        </a>
      )}
      {privacyLabel && <Link to="/privacy#s1" className="underline">{labels?.footer_operator}</Link>}
      <span className="font-mono" data-revision="">{revision.slice(0, 7)}</span>
    </footer>
  );
}
