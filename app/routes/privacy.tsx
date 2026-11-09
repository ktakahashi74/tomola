export { mathLinks as links } from "~/lib/math-style";
import type { Route } from "./+types/privacy";
import { loadNotice } from "~/lib/notice-route.server";
import { NoticePage, noticeMeta } from "~/components/notice-page";
export function loader({ request }: Route.LoaderArgs) { return loadNotice("privacy", request); }
export function headers() { return { "X-Robots-Tag": "noindex" }; }
export function meta({ loaderData }: Route.MetaArgs) { return noticeMeta(loaderData); }
export default function Page({ loaderData }: Route.ComponentProps) { return <NoticePage page={loaderData} />; }
