# Account deletion

Members can delete their account from the link at the bottom of settings.
Suggest exporting their data first. The default keeps posts and replies under
one shared departed-member identity; the other choice hides them immediately
and uses the configured retention period to erase their text and revisions.
No per-person substitute account or public member-page link is retained.
Chat messages are always deleted, including messages from former villages.
Report evidence, moderation history and access audit records keep their normal
retention rules. Explicit account deletion follows the same preservation scope
as other explicit member actions; automatic retention still checks its hold.

Owners can leave a village to its other owners or end it. A sole owner can
choose another member as the new owner or end the village; this choice is
required and has no default. An empty village
ends. The new owner receives a notification through their existing email
preferences. Language villages are excluded. Membership and ownership are
checked again during deletion; a changed roster can require the member to
reload and confirm again.

Deletion requires a login within the last 24 hours, plus the existing passkey
confirmation when signing is enabled. Repeated submissions reach the completed
screen using an opaque receipt that cannot authorize deletion. The current
username and previous names still held at departure stay anonymously reserved
for the normal rename period. Existing mention snapshots retain their frozen
targets, with bindings to the departing member cleared.

## Operator requests

Use a trusted operator shell with the application's database configuration.
For PGlite, stop the application before opening its directory. These commands
never migrate a database. Confirm the requester using the normal support
procedure before acting on their behalf.

```sh
pnpm exec tsx --env-file-if-exists=.env scripts/delete-account.ts run USER_ID --confirm-handle USERNAME --posts keep
pnpm exec tsx --env-file-if-exists=.env scripts/delete-account.ts status REQUEST_ID
pnpm exec tsx --env-file-if-exists=.env scripts/delete-account.ts retry REQUEST_ID
pnpm exec tsx --env-file-if-exists=.env scripts/delete-account.ts cancel REQUEST_ID
```

`run` defaults to `keep`; `--posts delete` selects erasure. Co-owned villages
remain with their other owners by default, and a village with no other members
ends. If a sole-owned village has other members, the command lists its name,
slug and total member count and stops before creating a deletion request or
changing any account data. Choose what happens to each listed village, then
rerun with one `--village` option per village:

```sh
pnpm exec tsx --env-file-if-exists=.env scripts/delete-account.ts run USER_ID --confirm-handle USERNAME --village community=end --village reading-group=member:NEXT_OWNER
```

`end` ends that village. `member:USERNAME` transfers ownership to a current
member. `transfer` leaves a co-owned village with its other owners. Use slugs
from the list, rather than village IDs; duplicate or unknown slugs and unknown
members are rejected. Any unchosen sole-owned shared village still stops the
whole operation. The member screen also requires an explicit choice for each
sole-owned shared village.

The journal records `pending`, `failed`, `cancelled` and `completed`. All database
changes commit in one transaction. A failure rolls them back; `retry` resumes
using the request ID, and repeated completion does not increase the count.
`cancel` stops a pending or failed request. A process stopped before commit
leaves the request pending, so inspect its status before retrying. Members
can also retry from the member screen with revised choices, replacing a
pending or failed request while keeping deletion serialized. Completion
clears the old user ID, username and village choices from the journal. Logs
contain request IDs and failure codes, not addresses or account contents.
The observation screen shows only the aggregate completed count.

## Completion mail

A mail job is committed with deletion and delivered afterward through the normal
mail worker. It states the post choice, chat deletion and the site's configured privacy contact (see [Operator settings](../deploy.md#operator-settings)).
The old address exists temporarily as the job's delivery destination. The worker
erases it after delivery or the final failed attempt, and refuses stale notices
older than the existing finished-job retention period. It is never part of the
observation export. If the journal reports failed delivery, obtain the confirmed
address again from the support request before queuing another attempt:

```sh
pnpm exec tsx --env-file-if-exists=.env scripts/delete-account.ts retry-mail REQUEST_ID --email ADDRESS
```

Do not retry a sent notice. A crash between mail acceptance and recording success
can deliver a duplicate confirmation; it cannot restore the account.

A suspended member's address is retained only as a domain-separated HMAC until
the expiry defined by `RETENTION.suspendedAccountHashYears`. Invitation creation
returns the same result as for other addresses; login and registration reject
the address while that deadline is active. Automatic retention
removes expired hashes subject to preservation holds. Other former members can
receive a new invitation for the same address; old sessions and credentials
remain invalid.
