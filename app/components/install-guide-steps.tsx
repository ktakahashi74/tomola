import { Share } from "lucide-react";
import { m } from "~/paraglide/messages.js";

export function InstallGuideSteps() {
  return <ol className="list-decimal space-y-2 ps-6">
    <li>{m.install_guide_share({ icon: "\ufffc" }).split("\ufffc").map((part, index) => <span key={index}>{index > 0 && <Share aria-hidden="true" className="mx-1 inline-block size-4 align-text-bottom" />}{part}</span>)}</li>
    <li>{m.install_guide_choose()}</li>
    <li>{m.install_guide_open()}</li>
  </ol>;
}
