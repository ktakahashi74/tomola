import { villageWriters } from "~/lib/village-writers.server";
import { AuthorLink } from "~/components/author-link";
import { villageIconUrl } from "~/lib/village-icon.server";
import { AvatarSettings } from "~/components/avatar-settings";
import { VillageHeader } from "~/components/village-header";
import { parseIdOrNull } from "~/lib/params.server";
import { VillageReportForm } from "~/components/village-moderation";
import { createVillageReport, hasOpenVillageReport, openVillageReportTargets } from "~/lib/village-moderation.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { chatUnreadCount } from "~/lib/village-chat.server";
import { data, Form, Link, redirect, useLocation } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/village";
import { OrderSwitch } from "~/components/order-switch";
import { ReadingLangMenu } from "~/components/reading-lang-menu";
import { Pagination } from "~/components/pagination";
import { TopicList } from "~/components/topic-list";
import { tracksNewPosts } from "~/lib/tracks-new-posts";
import { Button, buttonVariants } from "~/components/ui/button";
import { PersistentDetails } from "~/components/persistent-details";
import { getReader, requireWriter } from "~/lib/auth/session.server";
import { displayLangFor, langCarry, readingLanguageChoice, screenReadLangsFor, villageReaderFor } from "~/lib/display-lang.server";
import { decideVillageLangOf, localizeVillage, localizeVillages } from "~/lib/village-translations.server";
import { VillageTranslationNote, VILLAGE_ORIGINAL_PARAM } from "~/components/village-translation-note";
import { VillageSourceLang } from "~/components/village-source-lang";
import { listTopics } from "~/lib/entries.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { listAlternateQuery } from "~/lib/md/alternate";
import { villageMdMiddleware } from "~/lib/md/twin.server";
import { parseAsks, parseLong, parseOrder, parsePage } from "~/lib/params.server";
import { toTopicItems } from "~/lib/topic-list.server";
import { getViewer } from "~/lib/roles.server";
import { readPeekParam, readStanceMessage, skipRevalidationFor } from "~/lib/stance-ui";
import { readingHeaders } from "~/lib/public-reading.server";
import { readingRobotsMeta } from "~/lib/public-reading";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { changeVillageMembership, changeVillageMembershipResult, publicVillage, villageBySlug, villageMembership, villageForTopic } from "~/lib/villages.server";
import { parsePageParam } from "~/lib/pagination";
import { villageName } from "~/lib/village-name";
import { splitDescription, villageDescription } from "~/lib/village-description";
import { MoreInfo } from "~/components/ui/more-info";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { feedAlternate, sharePreviewMeta } from "~/lib/share-meta";
import { previewText } from "~/lib/share-text";
import { VillageInvites } from "~/components/village-invites";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { cancelVillageInvite, editVillage, emptyVillageManagement, endVillage, incomingVillageInvites, inviteToVillage, removeVillageMember, respondToVillageInvite, villageManagement, type VillageResult } from "~/lib/village-management.server";
import { villageError } from "~/lib/village-errors";
import { isFollowingVillage, setVillageFollow } from "~/lib/village-follows.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { formString } from "~/lib/entry-form.server";
import { VILLAGE_DESCRIPTION_MAX, VILLAGE_NAME_MAX, VILLAGE_REMOVAL_REASON_MAX } from "~/lib/villages";

export const middleware: Route.MiddlewareFunction[] = [villageMdMiddleware];
export function shouldRevalidate({ formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return skipRevalidationFor(formAction) ? false : defaultShouldRevalidate;
}
export function headers() { return readingHeaders(); }
export function meta({ loaderData, location, matches }: Route.MetaArgs) {
  if (!loaderData) return [];
  const { village } = loaderData;
  // The description is in the language of the screen when its translation is shown, and in the language it was written in otherwise.
  const lang = village.translation?.shown ? getLocale() : loaderData.source.lang ?? getLocale();
  const name = villageName(village);
  return [...readingRobotsMeta(matches), { title: name },
    ...sharePreviewMeta(matches, location, { type: "website", title: name, description: villageDescription(village) ? previewText(villageDescription(village), lang) : null, lang }),
    { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: `/v/${village.slug}.md${listAlternateQuery(location.search)}` },
    // An ended village has no feed (nothing new will come).
    ...(loaderData.ended ? [] : feedAlternate(matches, `/v/${village.slug}/feed.xml`, name, location))];
}
export async function loader({ request, params }: Route.LoaderArgs) {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  const { db, user, profile } = await getReader(request);
  const village = await villageBySlug(db, params.slug);
  if (!village) throw data("Not found", { status: 404 });
  const order = parseOrder(request);
  const asksOnly = parseAsks(request);
  const titledOnly = !asksOnly && parseLong(request);
  const viewer = user ? await getViewer(db, user) : undefined;
  const membership = user ? await villageMembership(db, village.id, user.id) : null;
  const operator = viewer?.scope.operator ?? false;
  const url = new URL(request.url);
  const rosterPage = parsePageParam(url.searchParams.get("membersPage"));
  const invitesPage = parsePageParam(url.searchParams.get("invitesPage"));
  if (rosterPage === null || invitesPage === null) throw data("Not found", { status: 404 });
  const resolveId = operator && village.language ? parseIdOrNull(url.searchParams.get("resolveReport") ?? undefined) : null;
  const resolveReportId = resolveId !== null && await hasOpenVillageReport(db, village.id, { reportId: resolveId }) ? resolveId : null;
  const management = user && profile && !village.language ? await villageManagement(db, village.id, user.id, rosterPage, invitesPage) : emptyVillageManagement();
  const result = await listTopics(db, { kind: "village", villageId: village.id }, { page: parsePage(request), viewer, order, asksOnly, titledOnly });
  const peekId = user ? readPeekParam(url) : null;
  // The name and description in the reader's language when they were written in another; ?vorig=1 keeps the original. `source` is always the original, for the owner's form.
  const localized = await localizeVillage(db, publicVillage(village), villageReaderFor(request, profile), { original: url.searchParams.get(VILLAGE_ORIGINAL_PARAM) === "1" });
  return {
    ...(resolveReportId !== null ? { resolveReportId } : {}),
    ...(villageChatEnabled() ? { chat: { joined: membership?.joined ?? false, unread: user && membership?.joined ? await chatUnreadCount(db, user.id, village.id) : 0 } } : {}),
    ...(user && profile ? { reported: await openVillageReportTargets(db, village.id, user.id) } : {}),
    reader: !user,
    village: { ...localized, iconUrl: villageIconUrl(village), hasIcon: !!village.iconMediaId },
    source: { name: village.name, description: village.description, lang: village.sourceLang ?? (user && (membership?.owner || operator) ? (await decideVillageLangOf(db, village)).lang : null) },
    membership,
    following: user ? await isFollowingVillage(db, user.id, village.id) : false,
    ended: village.endedAt !== null,
    operator,
    management,
    writers: await villageWriters(db, village.id),
    incoming: user ? await localizeVillages(db, (await incomingVillageInvites(db, user.id)).filter(invite => invite.slug === village.slug), villageReaderFor(request, profile)) : [],
    confirmingEnd: !village.language && membership?.owner && url.searchParams.get("end") === "confirm",
    readingLanguage: readingLanguageChoice(request, profile),
    order,
    unfiltered: !asksOnly && !titledOnly,
    langParam: langCarry(request),
    page: result.page,
    hasNext: result.hasNext,
    topics: await toTopicItems(db, result.topics, { readLangs: screenReadLangsFor(request, profile), displayLang: displayLangFor(request, profile), viewer: user && profile ? { userId: user.id, profile } : undefined, peek: new Set(peekId === null ? [] : [peekId]) }),
    stanceMessage: user ? readStanceMessage(url) : null,
  };
}
export async function action({ request, params }: Route.ActionArgs) {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  assertSameOrigin(request);
  const { db, user } = await requireWriter(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const text = (key: string) => typeof form.get(key) === "string" ? String(form.get(key)) : "";
  if (intent === "flag") {
    const rate = await hitMemberLimit(db, "report", user.id);
    if (!rate.allowed) return data({ reportError: "rate_limited", reported: false }, { status: 429, headers: rateLimitHeaders(rate) });
    const res = await createVillageReport(db, user.id, { slug: params.slug.toLowerCase(), reason: form.get("reason"), note: form.get("note"), target: form.get("target") });
    if (res.ok) return { reportError: null, reported: true };
    return data({ reportError: res.error, reported: false }, { status: res.error === "duplicate" ? 409 : res.error === "not_found" ? 404 : res.error === "forbidden" ? 403 : 400 });
  }
  if (intent === "follow" || intent === "unfollow") {
    const rate = await hitMemberLimit(db, "village-follow", user.id);
    if (!rate.allowed) return data({ error: "rate_limited" }, { status: 429, headers: rateLimitHeaders(rate) });
    const changed = await setVillageFollow(db, user.id, params.slug, intent === "follow");
    if (!changed.ok) throw data("Not found", { status: 404 });
    // The list of the followed villages comes back to itself; the village page stays where it is.
    const back = formString(form, "returnTo");
    if (back) throw redirect(safeLocalPath(back));
    return { ok: true };
  }
  if (intent === "join" || intent === "leave" || intent === "post-here") {
    const rate = await hitMemberLimit(db, "village-membership", user.id);
    if (!rate.allowed) return data({ error: "rate_limited" }, { status: 429, headers: rateLimitHeaders(rate) });
  }
  let result: VillageResult | undefined;
  if (intent === "edit") {
    // An edit queues paid translations, so it is limited like the edit of a post.
    await enforceMemberLimit(db, "edit", user.id);
    const raw = form.get("resolveReportId");
    const resolveReportId = typeof raw === "string" ? parseIdOrNull(raw) : undefined;
    if (resolveReportId === null) throw data("Bad request", { status: 400 });
    result = await editVillage(db, user.id, params.slug.toLowerCase(), { name: form.get("name"), description: form.get("description"), sourceLang: form.get("sourceLang"), ...(resolveReportId !== undefined ? { resolveReportId } : {}) });
  }
  else if (intent === "end") {
    if (form.get("confirm") !== "end") throw data("Bad request", { status: 400 });
    result = await endVillage(db, user.id, params.slug.toLowerCase());
  } else if (intent === "invite" || intent === "invite-owner") result = await inviteToVillage(db, user.id, params.slug.toLowerCase(), text("handle"), intent === "invite" ? "join" : "owner");
  else if (intent === "cancel-invite") result = await cancelVillageInvite(db, user.id, params.slug.toLowerCase(), text("invite"));
  else if (intent === "accept-invite" || intent === "decline-invite") result = await respondToVillageInvite(db, user.id, params.slug.toLowerCase(), text("invite"), intent === "accept-invite" ? "accepted" : "declined");
  else if (intent === "remove-member") result = await removeVillageMember(db, user.id, params.slug.toLowerCase(), text("handle"), form.get("reason"));
  if (result) {
    if (!result.ok) return data({ error: result.error }, { status: result.error === "forbidden" ? 403 : result.error === "not_found" ? 404 : 400 });
    const manage = ["edit", "end", "invite", "invite-owner", "cancel-invite", "remove-member"].includes(String(intent));
    throw redirect(`/v/${result.slug}${manage ? `?manage=1&notice=${intent}${intent === "remove-member" ? "#village-roster" : intent === "invite" || intent === "invite-owner" || intent === "cancel-invite" ? "#village-invites" : ""}` : ""}`);
  }
  if (intent === "post-here") {
    const joined = await db.transaction(tx => villageForTopic(tx, user.id, params.slug));
    if (!joined && !await changeVillageMembership(db, user.id, params.slug, "join")) throw data("Not found", { status: 404 });
    throw redirect(`/t/new?village=${encodeURIComponent(params.slug.toLowerCase())}`);
  }
  if (intent !== "join" && intent !== "leave") throw data("Bad request", { status: 400 });
  const changed = await changeVillageMembershipResult(db, user.id, params.slug, intent);
  if (!changed.ok) {
    if (changed.error === "last_owner") return data({ error: changed.error }, { status: 400 });
    throw data("Not found", { status: 404 });
  }
  return { ok: true };
}
export default function Village({ loaderData, actionData }: Route.ComponentProps) {
  const { village, source, membership, following, topics, order, page, hasNext, langParam, stanceMessage, ended, operator, management, incoming, confirmingEnd } = loaderData;
  const location = useLocation();
  const owner = membership?.owner ?? false;
  const search = new URLSearchParams(location.search);
  const managementOpen = search.get("manage") === "1" || confirmingEnd || "resolveReportId" in loaderData || search.has("invitesPage") || location.hash === "#village-invites";
  const canManage = owner || operator && !!village.language;
  const notices: Record<string, () => string> = { edit: m.village_saved, end: m.village_end_success, invite: m.village_invite_sent, "invite-owner": m.village_owner_invite_sent, "cancel-invite": m.village_invite_cancelled, "remove-member": m.village_member_removed };
  const noticeKey = search.get("notice") ?? "";
  const notice = canManage && Object.hasOwn(notices, noticeKey) ? notices[noticeKey]() : undefined;
  const leaveForm = <Form method="post"><Button type="submit" variant="outline" name="intent" value="leave" disabled={!ended && management.lastOwner}>{m.village_leave()}</Button></Form>;
  const leaveButton = membership?.joined && (village.kind === "invite_public" && !ended ? <details className="space-y-3"><summary className="link-ui cursor-pointer">{m.village_leave()}</summary><p className="font-semibold">{m.village_leave_confirm()}</p><p>{m.village_leave_invite_help()}</p>{leaveForm}</details> : leaveForm);
  const [shownDescription, restDescription] = splitDescription(villageDescription(village));
  // The description of the original is in its own language; a translated one is in the reader's.
  const descriptionLang = village.translation && !village.translation.shown ? village.translation.from : undefined;
  const mainAction = ended || !membership ? undefined : membership.joined
    ? <Link to={`/t/new?village=${village.slug}`} className={buttonVariants()}>{m.village_post_here()}</Link>
    : village.kind === "open" ? <Form method="post"><Button type="submit" name="intent" value="join">{m.village_join()}</Button></Form> : undefined;
  // Following is reading only (it does not let the member write or chat), so it is offered to any member, also one who has joined. An ended village cannot be newly followed.
  const followForm = !loaderData.reader && (following || !ended) ? <Form method="post">
    <Button type="submit" variant="outline" pressed={following} name="intent" value={following ? "unfollow" : "follow"}>{following ? m.village_following() : m.village_follow()}<span className="sr-only"> {villageName(village)}</span></Button>
  </Form> : undefined;
  return <main className="space-y-3 [overflow-wrap:anywhere]">
    <VillageHeader village={village} current="posts" chat={"chat" in loaderData ? { ...loaderData.chat!, member: !loaderData.reader } : undefined} actions={mainAction || followForm ? <>{mainAction}{followForm}</> : undefined} purpose={<>
      {shownDescription && <p lang={descriptionLang} className="whitespace-pre-wrap">{shownDescription}</p>}
      {restDescription && <MoreInfo label={m.village_description_more()} name={villageName(village)}><span lang={descriptionLang} className="whitespace-pre-wrap">{restDescription}</span></MoreInfo>}
      {village.translation && <VillageTranslationNote info={village.translation} />}
      {membership && <p className="flex flex-wrap gap-x-4 gap-y-1 ui-meta text-muted-foreground">{management.canReadRoster ? <Link to="#village-roster" className="link-ui">{m.village_members({ count: membership.members })}</Link> : <span>{m.village_members({ count: membership.members })}</span>}{membership.joined && <>{" "}<span>{m.village_joined()}</span></>}</p>}
    </>} />
    {!ended && membership && !membership.joined && village.kind === "open" && !village.language && <p className="ui-help">{m.village_join_visibility()}</p>}
    {actionData && "error" in actionData && <p role="alert">{villageError(String(actionData.error))}</p>}
    {ended && <p role="status">{m.village_ended()}</p>}
    {!ended && <VillageInvites invites={incoming} />}
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <OrderSwitch order={order} />
      {!loaderData.reader && <ReadingLangMenu choice={loaderData.readingLanguage} className="ms-auto" />}
    </div>
    {loaderData.writers.length > 0 && <section aria-label={m.village_writers()}><h2 className="heading-2">{m.village_writers()}</h2><ul className="flex flex-wrap gap-x-4 gap-y-2">{loaderData.writers.map(writer => <li key={writer.handle}><AuthorLink handle={writer.handle} name={writer.name} reader={loaderData.reader} /></li>)}</ul></section>}
    <TopicList compactMeta trackNew={tracksNewPosts({ page, order, filtered: !loaderData.unfiltered })} reader={loaderData.reader} topics={topics} order={order} langParam={langParam} empty={m.home_empty()} stanceMessage={stanceMessage} />
    <Pagination page={page} hasNext={hasNext} dropParams={["manage", "membersPage", "invitesPage"]} />
    {management.canReadRoster && <details id="village-roster" open={search.get("notice") === "remove-member" || management.rosterPage > 1 || new URLSearchParams(location.search).has("membersPage") || location.hash === "#village-roster"}><summary className="link-ui cursor-pointer">{m.village_roster()}</summary>
      {notice && search.get("notice") === "remove-member" && <p role="status">{notice}</p>}
      <ul className="space-y-3 py-3">{management.roster.map(member => <li key={member.handle} className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex flex-wrap gap-x-4"><AuthorLink handle={member.handle} name={member.name} byline />{" "}<span className="text-muted-foreground">{member.role === "owner" ? m.village_owner() : m.village_member_role()}</span></span>
        {owner && !member.self && <>
          {!ended && member.role !== "owner" && <Form method="post"><input type="hidden" name="handle" value={member.handle} /><Button type="submit" name="intent" value="invite-owner" variant="outline">{m.village_add_owner()}</Button></Form>}
          {!ended && member.role !== "owner" && village.kind === "invite_public" && <details className="min-w-0 open:basis-full"><summary className="link-ui cursor-pointer">{m.village_remove_member()}</summary><Form method="post" className="mt-2 max-w-xl space-y-2"><input type="hidden" name="handle" value={member.handle} />
            <label className="block space-y-1"><span>{m.village_removal_reason()}</span><Textarea name="reason" maxLength={VILLAGE_REMOVAL_REASON_MAX} /></label>
            <Button type="submit" name="intent" value="remove-member" variant="outline">{m.village_remove_member()}</Button>
          </Form></details>}
        </>}
      </li>)}</ul>
      <Pagination page={management.rosterPage} hasNext={management.rosterHasNext} pageParam="membersPage" keepFirstPage anchor="#village-roster" label={m.village_roster_pages()} dropParams={["invitesPage", "page"]} />
    </details>}
    {canManage && <PersistentDetails key={village.slug} id="village-management" open={managementOpen} className="space-y-3">
      <summary className="link-ui cursor-pointer">{m.village_manage()}</summary>
      {notice && search.get("notice") !== "remove-member" && <p role="status">{notice}</p>}
      {!ended && management.lastOwner && <p className="ui-help">{m.village_error_last_owner()}</p>}
      {owner && !ended && !village.language && <AvatarSettings village action={`/v/${village.slug}/icon`} url={village.iconUrl} uploaded={village.hasIcon} />}
      {(owner || operator && !!village.language) && <section className="space-y-4">
        <details open={"resolveReportId" in loaderData || search.get("notice") === "edit"}><summary className="link-ui cursor-pointer">{m.village_edit()}</summary>
          <Form method="post" className="mt-3 max-w-xl space-y-3">
            {"resolveReportId" in loaderData && <><input type="hidden" name="resolveReportId" value={loaderData.resolveReportId} /><p className="ui-help">{m.village_edit_resolve_reports()}</p></>}
            {!village.language && <label className="block space-y-1"><span>{m.village_name_field()}</span><Input name="name" defaultValue={source.name} required maxLength={VILLAGE_NAME_MAX} /></label>}
            <div className="space-y-1"><label htmlFor="edit-village-description">{m.village_description_field()}</label><Textarea id="edit-village-description" name="description" defaultValue={source.description} maxLength={VILLAGE_DESCRIPTION_MAX} /></div>
            <VillageSourceLang id="edit-village-source-lang" defaultValue={source.lang} />
            <Button type="submit" name="intent" value="edit">{m.save_changes()}</Button>
          </Form>
        </details>
        {!ended && owner && village.kind === "invite_public" && <Form method="post" className="max-w-xl space-y-2">
          <label className="block space-y-1"><span>{m.village_invite_handle()}</span><Input name="handle" required /></label>
          <p className="ui-help text-muted-foreground">{m.village_invite_member_help()}</p>
          <Button type="submit" name="intent" value="invite">{m.village_invite_member()}</Button>
        </Form>}
        {!ended && owner && <div id="village-invites" className="space-y-2">
        {management.invites.length > 0 && <ul className="space-y-2">{management.invites.map(invite => <li key={invite.id}>
          <Form method="post" className="flex flex-wrap items-center gap-2"><span className="inline-flex flex-wrap gap-x-4"><span>@{invite.handle}</span>{" "}<span className="text-muted-foreground">{invite.kind === "owner" ? m.village_owner_invitation() : m.village_membership_invitation()}</span></span>
            <input type="hidden" name="invite" value={invite.id} /><Button variant="outline" type="submit" name="intent" value="cancel-invite">{m.village_cancel_invite()}</Button>
          </Form>
        </li>)}</ul>}
        <Pagination page={management.invitesPage} hasNext={management.invitesHasNext} pageParam="invitesPage" keepFirstPage anchor="#village-invites" label={m.village_invite_pages()} dropParams={["membersPage", "page"]} />
        </div>}
        {!ended && !village.language && (confirmingEnd ? <div className="space-y-3" role="region" aria-label={m.village_end_confirm()}>
          <h3 className="font-semibold">{m.village_end_confirm()}</h3><p>{m.village_end_help()}</p>
          <Form method="post" className="flex flex-wrap gap-3"><input type="hidden" name="confirm" value="end" /><Button type="submit" name="intent" value="end">{m.village_end()}</Button><Link to={`/v/${village.slug}`} className="link-ui self-center">{m.village_keep()}</Link></Form>
        </div> : <Link to={`/v/${village.slug}?end=confirm`} className="link-ui inline-block">{m.village_end()}</Link>)}
      </section>}
      {leaveButton}
    </PersistentDetails>}
    {!canManage && leaveButton}
    {operator && !owner && !village.language && <Link className="link-ui inline-block" to={`/mod/village/${village.slug}`}>{m.village_mod_link()}</Link>}
    {"reportError" in (actionData ?? {}) && <p role="status">{actionData && "reportError" in actionData ? actionData.reportError === null ? m.flag_thanks() : actionData.reportError === "rate_limited" ? m.error_rate_limited() : actionData.reportError === "duplicate" ? m.flag_error_duplicate() : m.flag_error_invalid() : ""}</p>}
    {!owner && "reported" in loaderData && <VillageReportForm hasIcon={village.hasIcon} reported={loaderData.reported ?? []} />}
  </main>;
}
