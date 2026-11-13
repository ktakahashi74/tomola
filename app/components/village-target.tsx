import { entryErrorMessage } from "~/lib/entry-error-message";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigation } from "react-router";
import { FormVillageReviewContext } from "~/components/form-contexts";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { postingVillageName } from "~/lib/village-name";
import type { PostingVillages } from "~/lib/villages.server";
import { m } from "~/paraglide/messages.js";

export function isVillageTargetError(error: string | undefined): boolean {
  return error === "village_required" || error === "village_changed" || error === "village_target_none";
}

// The destination stays visible above the title, together with its public reach
// and validation errors. Pasted destinations still need server-side review.
export function VillageTarget({ posting, selected = posting.selected, explicitSelection = posting.explicit, frontmatter = false, reviewedBody, label = m.field_village(), error }: {
  error?: string;
  posting: PostingVillages; selected?: string; explicitSelection?: boolean; frontmatter?: boolean; reviewedBody?: string; label?: string;
}) {
  const [choice, setChoice] = useState(selected);
  const reachId = useId();
  const labelId = useId();
  const valueId = useId();
  const errorId = useId();
  const [reviewError, setReviewError] = useState<"village_required" | "village_changed" | null>(null);
  const targetError = reviewError ?? (isVillageTargetError(error) ? error : posting.choices.length === 0 ? "village_target_none" : undefined);
  const [explicit, setExplicit] = useState(explicitSelection);
  const [hint, setHint] = useState<string | null>(null);
  const explicitChoice = useRef(explicitSelection);
  const manuallyChosen = useRef(false);
  const reviewed = useRef(reviewedBody);
  const reviewFromSigning = useContext(FormVillageReviewContext);
  useEffect(() => {
    setReviewError(null);
    // Adopt server-resolved targets without remounting the open menu. A local
    // choice belongs to the editor, including one made while a save is pending.
    if (manuallyChosen.current) return;
    setChoice(selected);
    setExplicit(explicitSelection);
    explicitChoice.current = explicitSelection;
    setHint(null);
  }, [selected, explicitSelection]);
  useEffect(() => { setReviewError(null); }, [error]);
  useEffect(() => { reviewed.current = reviewedBody; }, [reviewedBody]);
  useEffect(() => {
    if (!reviewFromSigning) return;
    const applyReview = (slug: string | undefined, body: string, code: "village_required" | "village_changed") => {
      if (slug) {
        reviewed.current = body;
        setChoice(slug);
        setHint(null);
      }
      setReviewError(code);
      element.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    reviewFromSigning.current = applyReview;
    return () => { if (reviewFromSigning.current === applyReview) reviewFromSigning.current = null; };
  }, [reviewFromSigning]);
  const element = useRef<HTMLDivElement>(null);
  const navigation = useNavigation();
  const submitted = useRef(false);
  useEffect(() => {
    if (navigation.state !== "idle" && navigation.formData) submitted.current = true;
    if (navigation.state === "idle" && submitted.current) {
      submitted.current = false;
      if (targetError) element.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }, [targetError, navigation.state, navigation.formData]);
  useEffect(() => {
    const form = element.current?.closest("form");
    const reset = () => setReviewError(null);
    form?.addEventListener("tomola:village-review-reset", reset);
    return () => form?.removeEventListener("tomola:village-review-reset", reset);
  }, []);
  useEffect(() => {
    if (!frontmatter) return;
    const form = element.current?.closest("form");
    if (!form) return;
    // A display hint for ordinary pasted slug lines, never a validation or permission check.
    // Submission uses the full server-side YAML parser and membership check.
    const readHint = () => {
      if (explicitChoice.current) return;
      const body = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value ?? "";
      // The server's resolved destination wins for the body it has just checked.
      if (body === reviewed.current) { setHint(null); return; }
      const header = /^\ufeff?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(body)?.[1];
      const raw = header ? /^village:[ \t]*["']?(@?[a-zA-Z0-9][a-zA-Z0-9_-]*)["']?[ \t]*(?:#.*)?$/m.exec(header)?.[1] : undefined;
      setHint(raw && !["null", "true", "false"].includes(raw) ? raw.toLowerCase() : null);
    };
    readHint();
    form.addEventListener("input", readHint);
    return () => form.removeEventListener("input", readHint);
  }, [frontmatter, reviewedBody]);
  const displayed = !explicit && hint ? hint : choice;
  const village = posting.choices.find(row => row.slug === displayed);
  const name = village ? postingVillageName(village, posting.ownHandle) : displayed ? m.village_target_unavailable() : m.village_choose();
  const choose = (value: string) => { manuallyChosen.current = true; explicitChoice.current = true; setExplicit(true); setHint(null); setChoice(value); setReviewError(null); };
  return <div ref={element} data-village-target className="space-y-1">
    <input type="hidden" name="village" value={choice} />
    <input type="hidden" name="villageDisplayed" value={displayed} />
    <input type="hidden" name="villageExplicit" value={explicit ? "1" : "0"} />
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <span id={labelId}>{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger aria-invalid={Boolean(targetError) || undefined} aria-labelledby={`${labelId} ${valueId}`} aria-describedby={[reachId, targetError ? errorId : undefined].filter(Boolean).join(" ")} render={<Button type="button" variant="outline" className="h-auto max-w-full whitespace-normal" />}><span id={valueId} className="min-w-0 [overflow-wrap:anywhere]">{name}{village?.kind === "invite_public" && <> · {m.village_invite_public()}</>}</span><span aria-hidden="true">▾</span></DropdownMenuTrigger>
        <DropdownMenuContent className="max-w-[calc(100vw-2rem)]">
          <DropdownMenuRadioGroup value={displayed} onValueChange={choose}>
            {posting.choices.filter(row => row.slug).map(row => <DropdownMenuRadioItem key={row.slug} value={row.slug!} closeOnClick onClick={() => choose(row.slug!)}>{postingVillageName(row, posting.ownHandle)}</DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
          {posting.choices.length === 0 && <DropdownMenuGroup><DropdownMenuLabel className="p-2 ui-help">{m.village_target_none()}</DropdownMenuLabel></DropdownMenuGroup>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <p id={reachId} className="ui-help text-muted-foreground">{m.village_public_reach()}</p>
    {targetError && <p id={errorId} role="alert" className="ui-help text-destructive">{targetError === "village_target_none" ? m.village_target_none() : entryErrorMessage(targetError)}</p>}
    {posting.changed && <p role="status" className="ui-help">{m.village_default_restored()}</p>}
    {(posting.choices.length === 0 || targetError === "village_required") && <p className="ui-meta"><Link to="/villages" className="underline">{m.villages_title()}</Link></p>}
  </div>;
}
