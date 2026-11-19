import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ReplyFields } from "~/components/reply-fields";
import { SendButton, SignedFormFrame } from "~/components/signed-form-frame";
import { entryErrorMessage } from "~/lib/entry-error-message";
import { afterPageIdle } from "~/lib/initial-activation";
import { m } from "~/paraglide/messages.js";

type Fields = ComponentProps<typeof ReplyFields>;
const loadSigningControls = () => import("./signed-form-controls");
type DeferredSubmit = { form: HTMLFormElement; submitter: HTMLElement | null; snapshot: string };

export default function TopicReplyForm({ signatureRequired, respondWithPost, children, ...fields }: Pick<Fields,
  "nushiAvailable" | "owner" | "threadId" | "keeper" | "error" | "defaultLang" | "defaultBody" | "selectedLang" | "above" | "aiTools"
> & {
  signatureRequired: boolean;
  respondWithPost: (ComponentProps<typeof SendButton> & { formAction: string }) | null;
  children: ReactNode;
}) {
  const [signingControls, setSigningControls] = useState<Awaited<ReturnType<typeof loadSigningControls>>["default"] | null>();
  const loadStarted = useRef(false);
  const queuedSubmit = useRef<DeferredSubmit | null>(null);
  const prepareSigning = useCallback(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    void loadSigningControls().then(module => setSigningControls(() => module.default), () => setSigningControls(null));
  }, []);
  useEffect(() => afterPageIdle(prepareSigning), [prepareSigning]);
  useEffect(() => {
    if (signingControls === undefined) return;
    const queued = queuedSubmit.current;
    queuedSubmit.current = null;
    if (!queued?.form.isConnected || queued.submitter && !queued.form.contains(queued.submitter)) return;
    if (JSON.stringify([...new FormData(queued.form, queued.submitter)]) === queued.snapshot) queued.form.requestSubmit(queued.submitter ?? undefined);
  }, [signingControls]);
  return <SignedFormFrame controls={signingControls} reloadDocument={!signingControls} protectUnsaved="new" preserveUnsavedOnSamePath signatureRequired={signatureRequired}
    signIntent="" method="post" className="space-y-2" onPointerOver={prepareSigning} onFocusCapture={prepareSigning} onSubmit={event => {
      if (!signatureRequired || signingControls !== undefined) return;
      const submitter = event.nativeEvent.submitter;
      const values = new FormData(event.currentTarget, submitter);
      if (values.get("intent")) return;
      // Start review when the controls arrive, provided the requested reply is unchanged.
      event.preventDefault();
      queuedSubmit.current = { form: event.currentTarget, submitter, snapshot: JSON.stringify([...values]) };
      prepareSigning();
    }}>
    {children}
    <ReplyFields
      {...fields}
      errorId="reply-error"
      errorText={fields.error ? entryErrorMessage(fields.error, "reply") : undefined}
      actions={respondWithPost && <div className="flex flex-wrap gap-2">
        <SendButton>{m.submit_reply()}</SendButton>
        <SendButton {...respondWithPost} aria-describedby="respond-with-post-hint" />
        <p id="respond-with-post-hint" className="w-full ui-help text-muted-foreground">{m.respond_with_post_hint()}</p>
      </div>}
    />
  </SignedFormFrame>;
}
