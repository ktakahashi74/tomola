import { GUIDE_CONTENT_TYPE } from "~/lib/api/guides.server";
import { publicResponse } from "~/lib/api/http.server";
import { mdBlock } from "~/lib/md/frontmatter.server";
import { siteUrl } from "~/lib/md/urls.server";
import { noticeFor, renderNotice, type NoticeKind } from "~/lib/notices.server";
import { getLocale } from "~/paraglide/runtime.js";

export async function loadNotice(kind: NoticeKind, request: Request) {
  const asked = new URL(request.url).searchParams.get("lang");
  const doc = noticeFor(kind, asked ?? getLocale());
  return { ...doc, ...await renderNotice(doc) };
}
export function noticeMarkdown(kind: NoticeKind, request: Request) {
  const doc = noticeFor(kind, new URL(request.url).searchParams.get("lang") ?? "ja");
  const response = publicResponse(request, mdBlock({ type: "page", id: kind, lang: doc.lang, status: doc.lang === "ja" ? "original" : "unverified", canonical: siteUrl(`/${kind}`), original: doc.lang === "ja" ? undefined : siteUrl(`/${kind}.md`) }, doc.markdown), GUIDE_CONTENT_TYPE);
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}
