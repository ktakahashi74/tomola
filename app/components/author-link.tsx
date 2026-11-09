import { DELETED_MEMBER_HANDLE } from "~/lib/deleted-member";
import { m } from "~/paraglide/messages.js";
import { Link } from "react-router";

// Author labels use the current handle. A missing-profile placeholder has no member page.
export function AuthorLink({ handle, name, latin, reader = false, byline = false, handleClassName }: { handle: string; name?: string | null; latin?: string | null; reader?: boolean; byline?: boolean; handleClassName?: string }) {
  const departed = handle === DELETED_MEMBER_HANDLE;
  const label = departed ? m.account_delete_member() : name ? <><bdi>{name}</bdi>{byline && <>{latin && <> <bdi dir="ltr" className={handleClassName ?? "ui-meta font-normal text-muted-foreground"}>{latin}</bdi></>} {handleClassName ? <span className={handleClassName}>@{handle}</span> : `@${handle}`}</>}</> : `@${handle}`;
  if (departed || reader || handle === "?" || handle === "") return label;
  return <Link to={`/u/${handle}`} title={`@${handle}`} className="link-ui wrap-anywhere">{label}</Link>;
}
