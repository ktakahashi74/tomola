import type { Route } from "./+types/privacy-md";
import { noticeMarkdown } from "~/lib/notice-route.server";
export function loader({ request }: Route.LoaderArgs) { return noticeMarkdown("privacy", request); }
