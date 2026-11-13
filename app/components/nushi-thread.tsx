import { NushiAnswer, NushiCallStatus, type NushiAnswerView } from "./nushi";
import { Button } from "./ui/button";
import { m } from "~/paraglide/messages.js";

type NushiView = {
  answers: NushiAnswerView[];
  requests: Array<{ id: string; entryId: number; state: string; failure: string | null }>;
  hide: boolean; citations: boolean; setting: boolean | null;
};
export default function NushiThreadEntry({ entryId, view, member, nushiParentId }: { entryId: number; view: NushiView; member: boolean; nushiParentId?: number | null }) {
  return <div className="space-y-3">
    {nushiParentId && <p className="ui-meta"><a className="underline" href={`/nushi/${nushiParentId}`}>{m.nushi_name()} · {m.reply_target_link()}</a></p>}
    {view.answers.filter(answer => answer.entryId === entryId).map(answer => <NushiAnswer key={answer.id} answer={answer} hide={view.hide} member={member} />)}
    {view.requests.filter(request => request.entryId === entryId).map(request => <NushiCallStatus key={request.id} state={request.state} failure={request.failure} />)}
  </div>;
}
export function NushiThreadControls({ view, threadId, member, back }: { view: NushiView; threadId: number; member: boolean; back: string }) {
  return <>
    {view.setting !== null && <form method="post" action="/nushi/action" className="ui-help"><input type="hidden" name="intent" value="topic" /><input type="hidden" name="threadId" value={threadId} /><input type="hidden" name="returnTo" value={back} /><label><input type="checkbox" name="disabled" value="1" defaultChecked={view.setting} /> {m.nushi_disable_topic()}</label> <Button variant="outline" type="submit">{m.settings_email_save()}</Button></form>}
    {view.answers.length > 0 && <form method="post" action="/nushi/action" className="ui-help"><input type="hidden" name="intent" value={member ? "preferences" : "visitor-hide"} /><input type="hidden" name="returnTo" value={back} /><input type="hidden" name="citations" value={view.citations ? "1" : "0"} /><label><input type="checkbox" name="hide" value="1" defaultChecked={view.hide} /> {m.nushi_hide()}</label> <Button variant="outline" type="submit">{m.settings_email_save()}</Button></form>}
  </>;
}
