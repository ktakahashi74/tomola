import type { DisplayNames } from "~/lib/display-names.server";
import { m } from "~/paraglide/messages.js";

export function DisplayNameEvidence({ names }: { names: DisplayNames }) {
  return <dl className="space-y-1">
    {names.displayName && <div><dt className="ui-meta">{m.display_name_native()}</dt><dd><bdi>{names.displayName}</bdi></dd></div>}
    {names.displayNameLatin && <div><dt className="ui-meta">{m.display_name_latin()}</dt><dd><bdi>{names.displayNameLatin}</bdi></dd></div>}
  </dl>;
}
