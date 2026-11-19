import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ReplyFields } from "~/components/reply-fields";
import { SendButton, SignedFormFrame } from "~/components/signed-form-frame";
import { entryErrorMessage } from "~/lib/entry-error-message";
import { afterPageIdle } from "~/lib/initial-activation";
import { m } from "~/paraglide/messages.js";

type Fields = ComponentProps<typeof ReplyFields>;
type SigningControls = typeof import("./signed-form-controls").default;
let loadedSigningControls: SigningControls | undefined;
type DeferredSubmit = { form: HTMLFormElement; submitter: HTMLElement | null; snapshot: string };
const replyIdentity = (values: FormData) => JSON.stringify([values.get("body"), values.get("parentId"), values.get("intent")]);

export default function TopicReplyForm({ signatureRequired, respondWithPost, children, ...fields }: Pick<Fields,
  "nushiAvailable" | "owner" | "threadId" | "keeper" | "error" | "defaultLang" | "defaultBody" | "selectedLang" | "above" | "aiTools"
> & {
  signatureRequired: boolean;
  respondWithPost: (ComponentProps<typeof SendButton> & { formAction: string }) | null;
  children: ReactNode;
}) {
  const [signingControls, setSigningControls] = useState<SigningControls | null | undefined>(() => loadedSigningControls);
  const loadStarted = useRef(signingControls !== undefined);
  const queuedSubmit = useRef<DeferredSubmit | null>(null);
  const prepareSigning = useCallback(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    void import("./signed-form-controls").then(({ default: Controls }) => {
      loadedSigningControls = Controls;
      setSigningControls(() => Controls);
    }, () => setSigningControls(null));
  }, []);
  useEffect(() => signingControls === undefined ? afterPageIdle(prepareSigning) : undefined, [prepareSigning, signingControls]);
  useEffect(() => {
    if (signingControls === undefined) return;
    const queued = queuedSubmit.current;
    queuedSubmit.current = null;
    if (!queued?.form.isConnected || queued.submitter && !queued.form.contains(queued.submitter)) return;
    if (replyIdentity(new FormData(queued.form, queued.submitter)) === queued.snapshot) queued.form.requestSubmit(queued.submitter ?? undefined);
  }, [signingControls]);
  // Use router submissions after hydration so the draft keeper sees whether the server accepted the reply.
  return <SignedFormFrame controls={signingControls} protectUnsaved="new" preserveUnsavedOnSamePath signatureRequired={signatureRequired}
    signIntent="" method="post" className="space-y-2" onPointerOver={prepareSigning} onFocusCapture={prepareSigning} onSubmit={event => {
      if (signingControls !== undefined) return;
      const submitter = event.nativeEvent.submitter;
      const values = new FormData(event.currentTarget, submitter);
      if (values.get("intent")) return;
      // Send or review when loading settles, provided the requested reply is unchanged.
      event.preventDefault();
      queuedSubmit.current = { form: event.currentTarget, submitter, snapshot: replyIdentity(values) };
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
