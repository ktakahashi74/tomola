import { useRef } from "react";
import { useFetcher } from "react-router";
import { Button } from "./ui/button";
import { m } from "~/paraglide/messages.js";

export function AvatarSettings({ url, uploaded, action = "/settings/avatar", village = false }: { url: string; uploaded: boolean; action?: string; village?: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const upload = useFetcher<{ error?: string; url?: string; uploaded?: boolean }>();
  const busy = upload.state !== "idle";
  const error = upload.data?.error;
  return <section id={village ? "village-icon-settings" : "settings-avatar"} aria-label={village ? m.village_icon_label() : m.avatar_label()} className="scroll-mt-4 space-y-2">
    {village && <h3 className="text-sm font-semibold">{m.village_icon_label()}</h3>}
    <div className="flex flex-wrap items-center gap-3">
      <img src={url} alt="" className="member-avatar member-avatar-prominent rounded" />
      <input ref={picker} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={event => {
        const image = event.target.files?.[0]; event.target.value = "";
        if (!image || busy) return;
        const form = new FormData(); form.set("image", image);
        void upload.submit(form, { method: "post", action, encType: "multipart/form-data" });
      }} />
      <Button type="button" variant="outline" disabled={busy} onClick={() => picker.current?.click()}>{m.avatar_choose()}</Button>
      {uploaded && <Button type="button" variant="outline" disabled={busy} onClick={() => { void upload.submit({ intent: "reset" }, { method: "post", action }); }}>{village ? m.village_icon_reset() : m.avatar_reset()}</Button>}
    </div>
    {busy && <p role="status">{m.media_uploading()}</p>}
    {!busy && upload.data?.url && <p role="status">{m.settings_saved()}</p>}
    {!busy && error && <p role="alert">{error === "type" ? m.media_error_type() : error === "too_large" ? m.media_error_too_large() : error === "rate" ? m.media_error_rate() : error === "quota" ? m.media_error_quota() : error === "member_bytes" ? m.media_error_member_bytes() : error === "site_bytes" ? m.media_error_site_bytes() : m.media_error_generic()}</p>}
  </section>;
}
