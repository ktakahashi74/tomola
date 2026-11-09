import { Link } from "react-router";
import { OpenInAi } from "~/components/open-in-ai";
import { TopicShare } from "~/components/topic-share";
import { SaveButton } from "~/components/save-button";
import type { Lang } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";

export function TopicActions({ topicId, originalLang, readingLang, mdUrl, mdPath, reader, saved, returnTo, canReply = false }: {
  topicId: number; originalLang: Lang; readingLang: Lang; mdUrl: string; mdPath: string;
  reader: boolean; saved: boolean | null; returnTo: string; canReply?: boolean;
}) {
  const save = saved !== null && <SaveButton topicId={topicId} saved={saved} returnTo={`${returnTo}#p-${topicId}`} />;
  const openAndShare = <div className="flex flex-wrap items-start gap-1">
      <OpenInAi mdUrl={mdUrl} mdPath={mdPath} reader={reader} sourceLang={originalLang} readingLang={readingLang} />
      <TopicShare topicId={topicId} readingLang={readingLang} originalLang={originalLang} floating />
  </div>;
  return <div data-reading-actions="" className="flex flex-col items-start gap-3">
    {openAndShare}{save}
    {canReply && <Link to={`${returnTo}#reply`} className="ui-meta underline">{m.reply_write_title()}</Link>}
  </div>;
}
