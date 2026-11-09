# Retention and preservation holds

Retention periods are defined in `app/lib/retention.ts`. The daily `cleanup_jobs`
job runs at 03:00 UTC. Each category repeats short transactions of at most 100
changed rows, up to `RETENTION_MAX_BATCHES` in `app/lib/retention.ts` per invocation.
All categories share `RETENTION_MAX_RUN_MS` (60 seconds) of elapsed time per
invocation. The deadline and shutdown signal are checked before each transaction;
an in-flight transaction finishes before cleanup stops. This is a cooperative
budget, not a database statement timeout; the process shutdown grace limit still
applies. The hold is checked again before every
transaction. Periods use UTC, with calendar months and years clamped to the last
day of the target month. Read notifications expire from `read_at`;
unread notifications expire from `created_at`. The LLM ledger contains no
member identifier or request text.

The `identity_action_snapshots` and `identity_report_snapshots` categories clear
saved display names and avatar image pointers after 180 days, measured from the
action's creation or the report's handling time. Open reports remain intact.
An unresolved appeal concerning the same member and identity kind protects the
copies, including reports closed together without a direct action link. A decided
appeal protects them for another 180 days from its decision. The action and report
rows, reasons and statuses remain. Account deletion still clears these copies
immediately.

The `village_icon_actions` and `village_icon_reports` categories clear saved
village icon pointers after 180 days, measured from the action's creation or
the report's handling time. Open reports remain intact. An unresolved appeal
about icon removal or an action linked to an icon report for the same village
protects the copies, including reports closed together without a direct action
link. A decided appeal protects them for another 180 days from its decision.
The action and report rows, report targets, reasons and statuses remain.
Deleting the uploader's account clears the image bytes and pointers immediately.
Deleting an account that did not upload an image does not erase that image.
Physical village deletion cascades to its images; ending a village does not.

The `identity_avatar_media` category erases the bytes of old avatar images only
when no profile, village, report, action snapshot or post references them,
including current village icons and retained village icon evidence. It uses the
existing image deletion path, keeping a withdrawn URL tombstone. This separate
sweep resumes safely if cleanup stops after clearing a pointer. These five
categories share the usual hold, transaction, time and shutdown limits.

The `chat_translation_reports` category empties the original, translation and reporter note of handled reports (resolved or dismissed) 180 days after
they were handled, and records `pruned_at`; the rows and statuses remain. When the reported chat message is deleted (by its author, through account deletion, or from
the member's own message list), every report about it is emptied at once, handled or not: open or queued ones are also closed, and the rows and the record of who
closed them remain. Account deletion also erases the note a leaving member wrote on any report.

Author-deleted posts keep their tree position. Once due, their source text,
mention snapshots and signed payloads are purged. Translation report excerpts
are cleared while their rows, reporter notes and statuses remain. Unreferenced
revisions are
deleted; revisions referenced by moderation history keep only an empty marker
(`body = ''`, `title IS NULL`). An appeal filed after that purge can still be
reviewed, but cannot restore the erased text; both appeal screens explain this.
Hidden posts, operator-deleted posts and posts with pending appeals are protected.
The maintenance log reports `revisionsDeleted` and `revisionsPruned` separately.
The source, revisions and copies share the transaction's 100-row budget, including
a single post with a large history. Category logs and `run` output include
`removed` (rows deleted or cleared), `remaining`, `skipped`, `batches` and `stop`. For
`entry_content`, these count source rows and all affected copies together; the
separate entry log counts sources and the two revision outcomes. The
`chat_report_snapshots` category also counts cleared assessment copies. `limit`
defers the backlog to the next invocation, `time` exhausts the shared time budget,
and `signal` stops at a shutdown request. `hold` stops preservation work.
Short batches continue while work progresses. Blocked post or chat parents are
excluded from subsequent candidate windows in that invocation so their copies
cannot starve later records. Once no available work remains, `deferred` and
`skipped` report the eligible rows left by concurrent locks or changes, including
dependent copies that cannot yet be cleared. These are remaining rows, not a
cumulative count of repeated lock encounters. `complete` has no
remaining eligible rows at the time of the count. Protected records are excluded.

Run these commands with the deployed application's database configuration.
Do not put a database URL or credentials in shell history. For PGlite, stop the
application before opening its directory. These commands do not run migrations.

## Enable a preservation hold

When instructed to preserve records, stop automatic retention with:

```sh
pnpm exec tsx --env-file-if-exists=.env scripts/retention.ts hold --reason "Preservation case reference"
pnpm exec tsx --env-file-if-exists=.env scripts/retention.ts status
```

The permanent `retention_hold` row is the control. Enabling the hold waits for
any short cleanup transaction already in progress. Once the command completes,
later cleanup transactions skip all retention deletion and log that the hold is
active. A missing control row stops cleanup with an error; never delete it.
Keep the request, authority, scope, start time and review date in the operator's
restricted case record. The database reason should contain only a case reference.

This switch controls automatic retention. It does not block explicit member or
moderator actions, expire/revoke authentication, freeze external services, or
change backup rotation. If a preservation request also covers those operations
or backups, stop the affected writes and backup pruning separately and preserve
the requested copies before they rotate out. Already purged records cannot be
recovered from the live database.

Better Auth may independently delete expired verification records or sessions
when reading them; those library actions are outside this maintenance hold.

## Release and catch up

After the operator confirms that preservation can end, record that authorization
in the restricted case record and run:

```sh
pnpm exec tsx --env-file-if-exists=.env scripts/retention.ts release
pnpm exec tsx --env-file-if-exists=.env scripts/retention.ts run
```

`run` invokes only the cleanup handlers, without claiming translation, mail or
other queued jobs. It drains each category within the batch limit and shared
time budget, and refuses an active hold. Review the category counts and repeat as needed for a
capped, timed-out or locked backlog. SIGTERM/SIGINT also stop CLI cleanup after
the current transaction. Ordinary daily scheduling continues during a hold.

## After restoring a backup

Keep the application, workers and member traffic stopped. A restored backup can
contain an obsolete hold state and overdue `cleanup_jobs` that execute immediately
on worker startup. Use the current case record to choose the branch below:

```sh
# 1. Do not start the application or workers.
# 2. Inspect status, then check the current preservation case record.
pnpm exec tsx --env-file-if-exists=.env scripts/retention.ts status
# 3. Keep this at yes whenever preservation is required; do not run cleanup.
# Set it from the current case record, not the backup's hold state.
PRESERVATION_REQUIRED=yes
if [ "$PRESERVATION_REQUIRED" = yes ]; then
  pnpm exec tsx --env-file-if-exists=.env scripts/retention.ts hold --reason "Preservation case reference"
elif [ "$PRESERVATION_REQUIRED" = no ]; then
  # 4. Run only when no preservation request is current.
  pnpm exec tsx --env-file-if-exists=.env scripts/retention.ts run
fi
# 5. After the chosen branch succeeds, start the application and workers.
# Complete any deferred cleanup before reopening member traffic.
```

Preserve an active hold rather than releasing it to complete recovery. If a
confirmed obsolete hold blocks the no-preservation branch, follow the authorized
release procedure first. Review remaining counts and repeat cleanup for any
capped, timed-out or locked backlog before reopening traffic. Use the image
matching the restored schema; do not apply newer migrations merely to start an
older image.

## Rolling back to an image without preservation support

Images from before this feature do not honor `retention_hold`. Before starting
one, check the current preservation case record while the app and workers remain
stopped. If its schema supports the commands above, inspect `status` and set
`hold` when required. Otherwise inspect the control row read-only if present;
an absent table does not cancel a current preservation request.

When preservation is required or a hold is active, disable the old image's
cleanup before starting it. A Compose configuration override setting the app's
`WORKER_ENABLED` to `"false"` disables all background workers; the supplied Compose
file otherwise sets it to `"true"`. Keep this override for the entire hold. If
that old image cannot disable workers, keep it stopped. Its cleanup does not
become safe just because the database still contains a hold row. Follow the
same rule for an image-only rollback and for a restored database. Independent
authentication expiry still requires the separate precautions described above.

When preservation is not required, use a compatible retention-capable recovery
release to finish overdue cleanup offline before reopening member traffic.
Advancing a restored schema for that release is a deliberate recovery upgrade,
not part of starting the old image; keep the original recovery database intact.
See [deployment rollback](../deploy.md#6-updating-and-rollback) for image and
database selection. Do not expose restored overdue private records before cleanup.
