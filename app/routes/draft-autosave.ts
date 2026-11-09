import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/draft-autosave";
import { requireWriter } from "~/lib/auth/session.server";
import { drafts } from "~/lib/db/schema";
import { createDraft, getDraft, updateDraft, type Draft } from "~/lib/drafts.server";
import { applyPastedFrontmatter, formString, readEntryForm } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { MarkdownBusyError } from "~/lib/markdown-budget.server";
import { parseIdOrNull } from "~/lib/params.server";
import { defaultPostLang } from "~/lib/profiles.server";
import { DRAFT_RATE_LIMIT, hitMemberLimit, hitRateLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { signingViewToken } from "~/lib/signing.server";
import { titleOrNull } from "~/lib/text";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { lockVillageProfile } from "~/lib/villages.server";
import { readDraftRecoveryToken } from "~/lib/draft-recovery.server";
import { responseIdFromForm } from "~/lib/response-post.server";

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
function authFailure(error: unknown): Response {
  if (error instanceof Response) {
    const path = error.headers.get("Location")?.split("?")[0];
    if (path === "/suspended") return json({ error: "suspended" }, 403);
    if (path === "/login") return json({ error: "login_required" }, 401);
  }
  throw error;
}

export async function loader(args?: Route.LoaderArgs) {
  const value = args && new URL(args.request.url).searchParams.get("draftId");
  if (!args || value == null) return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  let member: Awaited<ReturnType<typeof requireWriter>>;
  try { member = await requireWriter(args.request); } catch (error) { return authFailure(error); }
  const id = parseIdOrNull(value);
  const draft = id === null ? null : await getDraft(member.db, member.user.id, id);
  return draft ? json({ id: draft.id, version: draft.version }) : json({ error: "not_found" }, 404);
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  let member: Awaited<ReturnType<typeof requireWriter>>;
  try { member = await requireWriter(request); } catch (error) { return authFailure(error); }
  const { user, db, profile } = member;
  try {
    const form = await request.formData();
    if (formString(form, "ownerId") !== user.id) return json({ error: "account_changed" }, 409);
    const raw = readEntryForm(form);
    const idText = formString(form, "draftId");
    const id = idText ? parseIdOrNull(idText) : null;
    if (idText && id === null) return json({ error: "not_found" }, 404);
    const source = id === null ? null : await getDraft(db, user.id, id);
    const recovering = new URL(request.url).searchParams.get("newdraft") === "1";
    const recovery = recovering ? readDraftRecoveryToken(user.id, formString(form, "recoveryToken")) : null;
    if (recovering && !recovery) return json({ error: "invalid_draft" }, 400);
    if (recovering && source) return json({ error: "draft_conflict" }, 409);
    // A late update must not recreate a published or deleted draft.
    if (id !== null && !source && !recovery) return json({ error: "not_found" }, 404);
    const kind = recovery?.kind ?? source?.kind ?? "topic";
    // Clearing a writing surface never erases the saved copy.
    if (!(kind === "topic" && raw.title.trim()) && !raw.body.trim()) return json({ skipped: true });
    const inputOf = async (fields: FormData) => {
      const values = readEntryForm(fields);
      if (formString(form, "newTopic") === "1") {
        const pasted = await applyPastedFrontmatter(values, "topic", { defaultLang: defaultPostLang(profile), allowComplex: true });
        if (!pasted.ok) return pasted;
        return { ...pasted, input: { ...pasted.input,
          ...(villagesEnabled() && values.villageExplicit === false && pasted.input.village === undefined ? { village: null } : {}),
        } };
      }
      return { ok: true as const, input: {
        title: values.title, body: values.body, lang: values.lang, asksStance: values.asksStance,
        ...(kind === "reply" ? { stanceTag: recovery || source?.threadAsksStance ? values.stanceTag : undefined } : {}),
        ...(villagesEnabled() ? { village: values.villageExplicit === false ? null : values.village } : {}),
      } };
    };
    const parsed = await inputOf(form);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const input = parsed.input;
    const resultOf = (draft: Pick<Draft, "id" | "version" | "title" | "body" | "lang" | "asksStance">) => ({ ...draft,
      signingView: signingViewToken({ userId: user.id, kind: "draft", id: draft.id, version: String(draft.version), title: draft.title, body: draft.body, lang: draft.lang }),
    });
    const matches = (candidate: typeof input, draft: Draft) => titleOrNull(kind === "reply" ? null : candidate.title) === draft.title
      && candidate.body === draft.body && candidate.lang === draft.lang && candidate.asksStance === draft.asksStance
      && (!("stanceTag" in candidate) || candidate.stanceTag === undefined || candidate.stanceTag === draft.stanceTag)
      && (!("aiAssistance" in candidate) || candidate.aiAssistance === draft.aiAssistance)
      && (!("village" in candidate) || candidate.village === undefined || (candidate.village || null) === (draft.village ?? null));
    if (source) {
      const expected = Number(formString(form, "version"));
      if (!Number.isSafeInteger(expected) || expected < 1) return json({ error: "draft_conflict" }, 409);
      const limit = await hitMemberLimit(db, "draft-autosave", user.id);
      if (!limit.allowed) return json({ error: "rate_limited" }, 429, rateLimitHeaders(limit));
      if (formString(form, "fork") !== "1") {
        const saved = await updateDraft(db, user.id, source.id, input, { expectedVersion: expected, skipUnchanged: true });
        if (saved.ok) return json(resultOf({ id: source.id, version: saved.version!, title: kind === "topic" ? titleOrNull(input.title) : null, body: input.body, lang: input.lang as Draft["lang"], asksStance: input.asksStance }));
        if (saved.error !== "draft_conflict") return json({ error: saved.error }, saved.error === "not_found" ? 404 : 400);
        const latest = await getDraft(db, user.id, source.id);
        if (!latest) return json({ error: "not_found" }, 404);
        let previousMatches = false;
        try {
          const previous = new FormData();
          for (const [key, value] of JSON.parse(formString(form, "previous")) as [string, string][]) previous.set(key, value);
          const prior = await inputOf(previous);
          previousMatches = prior.ok && matches(prior.input, latest);
        } catch { /* An absent or damaged device record is not proof of a previous save. */ }
        if (matches(input, latest)) return json(resultOf(latest));
        return json({ error: "draft_conflict", latest: resultOf(latest), previousMatches }, 409);
      }
    }
    const limit = await hitRateLimit(db, { key: `draft:member:${user.id}`, ...DRAFT_RATE_LIMIT });
    if (!limit.allowed) return json({ error: "rate_limited" }, 429, rateLimitHeaders(limit));
    const created = recovery ? await db.transaction(async tx => {
      if (recovery.altOf !== null && !input.asksStance) return { ok: false as const, error: "invalid_alt_of" as const };
      const copy = await createDraft(tx, user.id, { ...input, kind, threadId: recovery.threadId, parentId: recovery.parentId, altOf: null, aiAssistance: recovery.aiAssistance }, { responseTo: recovery.responseTo });
      // As with a conflict copy, preserve the authenticated immutable link even
      // if its question is unreadable. Publication still checks that question.
      if (copy.ok) await tx.update(drafts).set({ altOf: recovery.altOf, clientId: recovery.clientId, clientName: recovery.clientName, clientUri: recovery.clientUri, clientUpdatedAt: recovery.clientUpdatedAt ? new Date(recovery.clientUpdatedAt) : null }).where(eq(drafts.id, copy.id));
      return copy;
    }) : source ? await db.transaction(async tx => {
      if (villagesEnabled()) await lockVillageProfile(tx, user.id);
      const [row] = await tx.select().from(drafts).where(and(eq(drafts.authorId, user.id), eq(drafts.id, source.id))).for("update");
      if (!row) return { ok: false as const, error: "not_found" as const };
      if (row.altOf !== null && !input.asksStance) return { ok: false as const, error: "invalid_alt_of" as const };
      const copy = await createDraft(tx, user.id, { ...input, kind,
        threadId: row.threadId, parentId: row.parentId, altOf: null, aiAssistance: row.aiAssistance,
        ...(villagesEnabled() && kind === "topic" ? { village: input.village === undefined ? source.village : input.village } : {}),
      }, { responseTo: row.responseTo });
      // An existing draft can retain an unreadable original. Copy that immutable link;
      // publication still checks readability and the editor still offers unlinking.
      // The new web copy retains AI review metadata, without granting the API client access to it.
      if (copy.ok) await tx.update(drafts).set({ altOf: row.altOf,
        clientId: row.clientId ?? (row.via === "api" ? `token:${row.tokenId ?? "deleted"}` : null),
        clientName: row.clientName, clientUri: row.clientUri,
        clientUpdatedAt: row.clientUpdatedAt ?? (row.via === "api" ? row.updatedAt : null),
      }).where(eq(drafts.id, copy.id));
      return copy;
    }) : await createDraft(db, user.id, { kind, ...input }, { responseTo: formString(form, "newTopic") === "1" ? responseIdFromForm(form) : null });
    if (!created.ok) return json({ error: created.error }, created.error === "not_found" ? 404 : 400);
    return json({ ...resultOf({ id: created.id, version: 1, title: kind === "topic" ? titleOrNull(input.title) : null, body: input.body, lang: input.lang as Draft["lang"], asksStance: input.asksStance }), copied: source !== null || recovering });
  } catch (error) {
    if (error instanceof MarkdownBusyError) return json({ error: "busy" }, 503, { "Retry-After": "1" });
    throw error;
  }
}
