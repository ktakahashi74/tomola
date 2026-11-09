export { mathLinks as links } from "~/lib/math-style";
export { signedDocumentHeaders as headers } from "~/components/signed-document";
import { SignedDocumentPage, signedDocumentMeta } from "~/components/signed-document";
import { loadSignedDocument } from "~/lib/signed-document-route.server";
import { whyDocuments } from "~/lib/why.server";
import type { Route } from "./+types/why";

export function loader({ request }: Route.LoaderArgs) {
  return loadSignedDocument(request, whyDocuments);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return signedDocumentMeta("/why", loaderData);
}

export default function Why({ loaderData }: Route.ComponentProps) {
  return <SignedDocumentPage path="/why" {...loaderData} />;
}
