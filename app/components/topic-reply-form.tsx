import { useLayoutEffect, type ComponentProps, type ReactNode } from "react";
import { ReplyFields } from "~/components/reply-fields";
import { SendButton, SignedForm } from "~/components/signed-form";
import { entryErrorMessage } from "~/lib/entry-error-message";
import { m } from "~/paraglide/messages.js";

type Fields = ComponentProps<typeof ReplyFields>;

export default function TopicReplyForm({ adoptReplyBody, signatureRequired, respondWithPost, children, ...fields }: Pick<Fields,
  "nushiAvailable" | "owner" | "threadId" | "keeper" | "error" | "defaultLang" | "defaultBody" | "selectedLang" | "above" | "aiTools"
> & {
  adoptReplyBody: () => void;
  signatureRequired: boolean;
  respondWithPost: (ComponentProps<typeof SendButton> & { formAction: string }) | null;
  children: ReactNode;
}) {
  useLayoutEffect(adoptReplyBody, [adoptReplyBody]);
  return <SignedForm protectUnsaved="new" preserveUnsavedOnSamePath signatureRequired={signatureRequired} signIntent="" method="post" className="space-y-2">
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
  </SignedForm>;
}
