import { useEffect, useMemo, useRef } from "react";
import { baseOf, draftStoreForOwner, localDraftKey, localDraftStore } from "~/lib/local-draft";

// Editing-only recovery stays out of the eagerly loaded new-post keeper.
// Mount with the editor, so the owner generation predates a later logout.
export default function RefusedEditKeeper({ owner, scope, startTitle, startBody, refused }: {
  owner: string; scope: string; startTitle?: string | null; startBody: string; refused?: object;
}) {
  const holder = useRef<HTMLSpanElement>(null);
  const store = useMemo(() => draftStoreForOwner(owner, localDraftStore), [owner]);
  useEffect(() => {
    if (!refused) return;
    const form = holder.current?.closest("form");
    if (!form) return;
    const input = new FormData(form);
    const body = input.get("body");
    if (typeof body !== "string") return;
    const title = input.get("title");
    // Another tab's accepted edit may have removed the shared record. Restore
    // it even for option-only attempts, without signing proofs or view tokens.
    store.write(localDraftKey(owner, scope), {
      ...(typeof title === "string" ? { title } : {}), body,
      base: baseOf(startTitle, startBody), savedAt: Date.now(),
      fields: JSON.stringify([...input].filter(([name]) => ["title", "body", "lang", "stanceTag", "editVersion"].includes(name))),
    });
  }, [refused, owner, scope, startTitle, startBody, store]);
  return <span ref={holder} hidden />;
}
