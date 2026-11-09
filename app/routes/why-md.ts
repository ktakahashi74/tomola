import { signedDocumentMarkdownResponse } from "~/lib/signed-document-route.server";
import { whyDocuments } from "~/lib/why.server";
import type { Route } from "./+types/why-md";

export function loader({ request }: Route.LoaderArgs) {
  return signedDocumentMarkdownResponse(request, whyDocuments);
}
