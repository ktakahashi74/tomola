import { signedDocumentMarkdownResponse } from "~/lib/signed-document-route.server";
import { nameDocuments } from "~/lib/name.server";
import type { Route } from "./+types/name-md";

export function loader({ request }: Route.LoaderArgs) {
  return signedDocumentMarkdownResponse(request, nameDocuments);
}
