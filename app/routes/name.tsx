export { mathLinks as links } from "~/lib/math-style";
export { signedDocumentHeaders as headers } from "~/components/signed-document";
import { SignedDocumentPage, signedDocumentMeta } from "~/components/signed-document";
import { loadSignedDocument } from "~/lib/signed-document-route.server";
import { nameDocuments } from "~/lib/name.server";
import type { Route } from "./+types/name";

export function loader({ request }: Route.LoaderArgs) {
  return loadSignedDocument(request, nameDocuments);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return signedDocumentMeta("/name", loaderData);
}

export default function Name({ loaderData }: Route.ComponentProps) {
  return <SignedDocumentPage path="/name" {...loaderData} />;
}
