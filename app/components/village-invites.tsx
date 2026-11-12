import { Form, Link } from "react-router";
import { ListMeta } from "~/components/list-meta";
import { Button } from "~/components/ui/button";
import { villageName } from "~/lib/village-name";
import { m } from "~/paraglide/messages.js";

export type VillageInviteView = { id: string; kind: string; slug: string | null; name: string; description: string; language: string | null; villageKind: string; inviter: string; members: number };
export function VillageInvites({ invites }: { invites: VillageInviteView[] }) {
  if (!invites.length) return null;
  return <section className="space-y-3" aria-label={m.village_incoming()}>
    <h2 className="heading-2">{m.village_incoming()}</h2>
    <ul className="divide-y">{invites.map(invite => <li key={invite.id} className="space-y-2 py-3 [overflow-wrap:anywhere]">
      <Link to={`/v/${invite.slug}`} className="link-ui font-semibold">{villageName(invite)}</Link>
      {invite.description && <p className="whitespace-pre-wrap">{invite.description}</p>}
      <ListMeta items={[
        invite.villageKind === "invite_public" && { key: "kind", content: m.village_invite_public() },
        { key: "members", content: m.village_members({ count: invite.members }) },
        { key: "inviter", content: m.village_invited_by({ handle: invite.inviter }) },
        { key: "invitation", content: invite.kind === "owner" ? m.village_owner_invitation() : m.village_membership_invitation() },
      ]} />
      <p className="ui-help">{m.village_join_visibility()}</p>
      <Form method="post" action={`/v/${invite.slug}`} className="flex flex-wrap gap-2">
        <input type="hidden" name="invite" value={invite.id} />
        <Button type="submit" name="intent" value="accept-invite">{m.village_accept()}</Button>
        <Button type="submit" name="intent" value="decline-invite" variant="outline">{m.village_decline()}</Button>
      </Form>
    </li>)}</ul>
  </section>;
}
