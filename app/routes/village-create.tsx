import { data, Form, redirect, Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { Route } from "./+types/village-create";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { createVillage } from "~/lib/village-management.server";
import { villageError } from "~/lib/village-errors";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { validVillageSlug, villageNameNeedsAiSlug, villageSlugFromName, VILLAGE_DESCRIPTION_MAX, VILLAGE_NAME_MAX, VILLAGE_SLUG_MAX } from "~/lib/villages";
import { villageSlugSuggestEnabled } from "~/lib/village-slug-suggest-config.server";
import { VillageSourceLang } from "~/components/village-source-lang";
import { memberVillageLang } from "~/lib/village-translations.server";
import { m } from "~/paraglide/messages.js";

export function meta() { return [{ title: m.village_create() }]; }
export async function loader({ request }: Route.LoaderArgs) {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  const { profile } = await requireWriter(request);
  return { sourceLang: memberVillageLang(profile), suggestSlug: villageSlugSuggestEnabled() };
}
export async function action({ request }: Route.ActionArgs) {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  assertSameOrigin(request);
  const { db, user } = await requireWriter(request);
  const form = await request.formData();
  const result = await createVillage(db, user.id, { slug: form.get("slug"), kind: form.get("kind"), name: form.get("name"), description: form.get("description"), sourceLang: form.get("sourceLang") });
  if (!result.ok) return data({ error: result.error }, { status: result.error === "forbidden" ? 403 : result.error === "rate_limited" ? 429 : 400 });
  throw redirect(`/v/${result.slug}`);
}
export default function VillageCreate({ actionData, loaderData: { sourceLang, suggestSlug } }: Route.ComponentProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [suggestionStatus, setSuggestionStatus] = useState<"idle" | "pending" | "failed">("idle");
  const suggestButton = useRef<HTMLButtonElement>(null);
  const current = useRef({ managed: true, pending: null as AbortController | null,
    lastSuggestion: null as { name: string; slug: string | null } | null });
  useEffect(() => {
    const state = current.current;
    return () => {
      state.pending?.abort();
      state.pending = null;
    };
  }, []);

  const needsAi = villageNameNeedsAiSlug(name);
  const localSlug = needsAi ? null : villageSlugFromName(name);
  const suggesting = suggestionStatus === "pending";
  const cancelSuggestion = () => {
    current.current.pending?.abort();
    current.current.pending = null;
    setSuggestionStatus("idle");
  };
  const changeName = (name: string) => {
    cancelSuggestion();
    setName(name);
    if (current.current.managed) setSlug(villageSlugFromName(name) ?? "");
  };
  const suggestFromName = async (explicit: boolean) => {
    const state = current.current;
    if (!suggestSlug || state.pending || (!explicit && !state.managed)) return;
    if (!needsAi) {
      if (explicit && localSlug !== null) {
        state.managed = true;
        setSlug(localSlug);
      }
      return;
    }
    const last = state.lastSuggestion;
    if (!explicit && last?.name === name && (last.slug === null || slug === last.slug)) return;

    const controller = new AbortController();
    state.pending = controller;
    setSuggestionStatus("pending");
    const timeout = setTimeout(() => {
      controller.abort();
      if (state.pending === controller) {
        state.pending = null;
        setSuggestionStatus("failed");
      }
    }, 4000);
    let suggestion: string | null | undefined;
    try {
      const response = await fetch("/villages/suggest-slug", {
        method: "POST", body: new URLSearchParams({ name }), signal: controller.signal,
      });
      if (response.ok) {
        const result: unknown = await response.json();
        if (result && typeof result === "object" && "slug" in result && (result.slug === null || validVillageSlug(result.slug))) {
          suggestion = result.slug;
        }
      }
    } catch {
      // Leave the current address in the field if the request fails.
    } finally {
      clearTimeout(timeout);
    }
    if (state.pending !== controller) return;
    state.pending = null;
    if (suggestion !== undefined) state.lastSuggestion = { name, slug: suggestion };
    if (suggestion) {
      state.managed = true;
      setSlug(suggestion);
    }
    setSuggestionStatus(suggestion ? "idle" : "failed");
  };
  return <main className="max-w-xl space-y-4 [overflow-wrap:anywhere]">
    <h1 className="text-2xl font-bold">{m.village_create()}</h1>
    {actionData?.error && <p role="alert">{villageError(actionData.error)}</p>}
    <Form method="post" className="space-y-4" onSubmit={cancelSuggestion}>
      <fieldset className="space-y-2"><legend className="font-semibold">{m.village_kind()}</legend>
        <label className="flex gap-2"><input type="radio" name="kind" value="open" defaultChecked />{m.village_kind_open_option()}</label>
        <label className="flex gap-2"><input type="radio" name="kind" value="invite_public" />{m.village_kind_invite_option()}</label>
        <p className="ui-help text-muted-foreground">{m.village_kind_fixed()}</p>
      </fieldset>
      <label className="block space-y-1"><span>{m.village_name_field()}</span><Input name="name" required maxLength={VILLAGE_NAME_MAX} onChange={event => changeName(event.target.value)} onBlur={event => {
        if (event.relatedTarget !== suggestButton.current) void suggestFromName(false);
      }} /></label>
      <div className="space-y-1">
        <label htmlFor="village-slug">{m.village_slug_field()}</label>
        <div className="flex flex-wrap items-center gap-2">
          <Input id="village-slug" name="slug" className="min-w-32 flex-1" required maxLength={VILLAGE_SLUG_MAX} pattern="[a-z0-9]+(-[a-z0-9]+)*" autoCapitalize="none" autoCorrect="off" aria-describedby={suggestSlug ? "village-slug-status village-slug-help village-slug-ai-help" : "village-slug-help"} value={slug} onChange={event => {
            cancelSuggestion(); current.current.managed = event.target.value === ""; setSlug(event.target.value);
          }} />
          {suggestSlug && <Button ref={suggestButton} type="button" variant="outline" disabled={!needsAi && localSlug === null} pending={suggesting} onClick={() => { void suggestFromName(true); }}>
            {m.village_slug_suggest()}
          </Button>}
        </div>
        {suggestSlug && <p id="village-slug-status" role="status" className="ui-help flex items-center gap-1.5 text-foreground">
          {suggesting && <><LoaderCircle aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />{m.village_slug_suggesting()}</>}
          {suggestionStatus === "failed" && m.village_slug_suggest_failed()}
        </p>}
        <p id="village-slug-help" className="ui-help text-muted-foreground">{m.village_slug_help()}</p>
        {suggestSlug && <p id="village-slug-ai-help" className="ui-help text-muted-foreground">{m.village_slug_ai_help()}</p>}
      </div>
      <label className="block space-y-1"><span>{m.village_description_field()}</span><Textarea name="description" maxLength={VILLAGE_DESCRIPTION_MAX} /></label>
      <VillageSourceLang id="village-source-lang" defaultValue={sourceLang} />
      <div className="flex flex-wrap gap-3"><Button type="submit">{m.village_create()}</Button><Link to="/villages" className="self-center underline">{m.cancel()}</Link></div>
    </Form>
  </main>;
}
