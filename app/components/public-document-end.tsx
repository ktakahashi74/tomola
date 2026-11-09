import { Link } from "react-router";
import { useDocumentMember } from "~/lib/document-member";
import { m } from "~/paraglide/messages.js";

// The end of the public documents (principles, why): a way back into the posts, and one plain line on how to join. The documents are the same for
// everyone and read no session, so the line is a fact that holds for any reader who is not yet a member (a member does not need to be told how to join).
export function PublicDocumentEnd() {
  const member = useDocumentMember();
  return <footer className="space-y-1 border-t pt-4">
    <p><Link to="/" className="underline">{m.public_document_read_posts()}</Link></p>
    {!member && <p className="ui-help text-muted-foreground">{m.public_document_invitation()}</p>}
  </footer>;
}
