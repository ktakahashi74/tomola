import { m } from "~/paraglide/messages.js";

export function NushiMentionHelp() {
  const [before, after] = m.nushi_mention_help({ nushi: "\u0000" }).split("\u0000");
  return <p data-nushi-mention-help className="ui-help text-muted-foreground">{before}<a href="/ai-use#nushi" className="underline">{m.nushi_name()}</a>{after}</p>;
}
