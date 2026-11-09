import type { Route } from "./+types/terms-md";
import { noticeMarkdown } from "~/lib/notice-route.server";
export function loader({ request }: Route.LoaderArgs) { return noticeMarkdown("terms", request); }
