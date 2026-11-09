import { m } from "~/paraglide/messages.js";

export default function PostedLineContent({ kind }: { kind: "reply-followed" | "edited" }) {
  return <p role="status" className="text-success">{kind === "edited" ? m.edited_saved() : m.posted_reply_followed()}</p>;
}
