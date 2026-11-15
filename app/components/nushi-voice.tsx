import { Form } from "react-router";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { NUSHI_VOICE_MAX } from "~/lib/nushi-voice";
import type { publicNushiVoice } from "~/lib/nushi-voice.server";
import { m } from "~/paraglide/messages.js";

export function NushiVoiceSetting({ text }: { text: string }) {
  return <Form method="post" className="max-w-xl space-y-2" data-nushi-voice-setting aria-label={m.nushi_voice_title()}>
    <label className="block space-y-1"><span>{m.nushi_voice_title()}</span><Textarea name="voice" defaultValue={text} rows={4} maxLength={NUSHI_VOICE_MAX * 2} onInput={event => event.currentTarget.setCustomValidity([...event.currentTarget.value].length > NUSHI_VOICE_MAX ? m.nushi_voice_invalid() : "")} aria-describedby="nushi-voice-help" /></label>
    <p id="nushi-voice-help" className="ui-help">{m.nushi_voice_help()}</p>
    <p className="ui-help">{m.nushi_voice_public_help()}</p>
    <Button type="submit" name="intent" value="nushi-voice" variant="outline">{m.nushi_voice_save()}</Button>
    <Button type="submit" name="intent" value="nushi-voice-clear" formNoValidate variant="outline">{m.nushi_voice_clear()}</Button>
  </Form>;
}

export function NushiVoicePublic({ voice }: { voice: NonNullable<Awaited<ReturnType<typeof publicNushiVoice>>> }) {
  return <section id="nushi-voice" className="space-y-2" aria-labelledby="nushi-voice-heading">
    <h2 id="nushi-voice-heading" className="heading-2">{m.nushi_voice_title()}</h2>
    <p className="ui-help">{m.nushi_voice_owner_label()}</p>
    <p className="whitespace-pre-wrap" dir="auto" data-nushi-voice-text>{voice.text || m.nushi_voice_default()}</p>
    {voice.history.length > 0 && <details><summary className="cursor-pointer underline">{m.nushi_voice_history()}</summary>
      <ol className="space-y-3 py-2">{voice.history.map(event => <li key={event.id} id={`nushi-voice-${event.id}`} className="space-y-1">
        <p className="ui-meta"><time dateTime={event.date}>{event.date}</time> · {event.actor ? `@${event.actor}` : m.nushi_left()}{event.removed && <> · {m.nushi_voice_removed()}</>}</p>
        <p className="whitespace-pre-wrap" dir="auto">{event.text || m.nushi_voice_default()}</p>
      </li>)}</ol>
    </details>}
  </section>;
}
