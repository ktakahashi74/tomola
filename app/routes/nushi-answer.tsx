import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { nushiPreferences } from "~/lib/nushi-settings.server";
import { data } from "react-router";
import type { Route } from "./+types/nushi-answer";
import { getReader } from "~/lib/auth/session.server";
import { readNushiAnswer } from "~/lib/nushi.server";
import { displayLangFor } from "~/lib/display-lang.server";
import { renderNushiAnswerPage } from "~/lib/nushi-html.server";
import { m } from "~/paraglide/messages.js";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { db, user, profile } = await getReader(request);
  const answer = await readNushiAnswer(db, Number(params.id), displayLangFor(request, profile));
  if (!answer) throw data("Not found", { status: 404 });
  const preferences = await nushiPreferences(db, user?.id, request);
  return { html: renderNushiAnswerPage(answer, preferences, !!user), title: m.nushi_name() };
}
export const headers = () => ({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
export function meta({ loaderData }: Route.MetaArgs) { return [{ title: loaderData?.title }]; }
export default function NushiAnswerPage({ loaderData }: Route.ComponentProps) {
  return <div dangerouslySetInnerHTML={{ __html: loaderData.html }} />;
}

export const middleware = [privateCacheMiddleware];
