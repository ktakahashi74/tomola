import { useState, useSyncExternalStore } from "react";
import { DocumentHeader } from "~/components/document-header";
import { CopyTextButton } from "~/components/copy-text-button";
import { siteUrl } from "~/lib/md/urls.server";
import { WRITING_MD_PATH } from "~/lib/writing-paths";
import { m } from "~/paraglide/messages.js";
import type { Route } from "./+types/writing";

export function loader() {
  return { address: siteUrl(WRITING_MD_PATH) };
}

export const headers = () => ({ "X-Robots-Tag": "noindex", "Cache-Control": "private, no-store" });
export function meta() {
  return [{ title: m.writing_guide_title() }, { name: "robots", content: "noindex" }, { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: WRITING_MD_PATH }];
}

const subscribe = () => () => {};

export default function Writing({ loaderData: { address } }: Route.ComponentProps) {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const [copied, setCopied] = useState(false);
  return <>
    <DocumentHeader />
    <main className="min-w-0 space-y-6">
      <h1 className="text-2xl font-bold">{m.writing_guide_title()}</h1>
      <p className="text-lg font-semibold">{m.writing_guide_prompt()}</p>
      <fieldset disabled={!hydrated} className="min-w-0 space-y-2">
        <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded border bg-muted p-2 text-sm select-all"><code><a href={WRITING_MD_PATH} className="underline">{address}</a></code></pre>
        <CopyTextButton text={address} label={copied ? m.connect_address_copied() : m.connect_copy_address()} copiedLabel={m.connect_address_copied()} failedLabel={m.connect_copy_failed()} onResult={setCopied} />
      </fieldset>
      <ul className="list-disc space-y-2 pl-5">
        <li>{m.writing_guide_formats()}</li>
        <li>{m.writing_guide_language()}</li>
        <li>{m.writing_guide_rights()}</li>
        <li>{m.writing_guide_publish()}</li>
      </ul>
    </main>
  </>;
}
