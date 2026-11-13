# Deployment guide

## Operator settings

Every deployed server needs `TOMOLA_OPERATOR_DIR`, pointing to one directory
containing `operator.json` and these Markdown directories:

| Path | Required editions | Contents |
| --- | --- | --- |
| `terms/<lang>.md` | `en`, `ja` | The site's participation agreement, starting with `# ` |
| `privacy/<lang>.md` | `en`, `ja` | The site's privacy notice, starting with `# ` |
| `ai-policy/<lang>.md` | `en` | Automated retrieval, indexing, training and redistribution policy |
| `principles-footer/<lang>.md` | `en`, `ja` | Operator paragraph added at the start of principles section 6 |
| `principles-rules-status/<lang>.md` | `en`, `ja` | Inline status or link for the separate participation-rules page in section 6 |
| `principles-objections-contact/<lang>.md` | `en`, `ja` | Complete Markdown list item (`- ...`) describing the objection contact in section 7 |

Other editions of these three principles documents are optional and fall back
to English, independently of the enabled interface languages. The canonical
principles keep the participation-rules explanation and moderation-objection
instructions; `{{principles-rules-status}}` and
`{{principles-objections-contact}}` insert the operator's current information.
Provide wording for the site's actual readiness and contact routes. The
AI guide currently uses the English policy. Keep the policy explicit about
public MCP access: technical access does not itself grant reuse permission.
Notices use Japanese for `ja` and English for other interface languages.
Use consecutively numbered `## 1. ...` sections in notices. Privacy section 1
identifies the operator; section 6 supplies the contact information linked by mail.

Start with a copy of `deploy/operator.example/` outside the source checkout.
Replace the example identity, addresses, policy copy and every `REPLACE_ME`
marker, review the documents for the actual operation, then set `status` to
`configured`. The example is a content outline, not legal advice. Do not put
credentials or member information in this directory; its documents and the
public settings are visible to visitors.

All fields in `operator.json` are required. Unknown fields are rejected:

- `status`: exactly `configured`; the example's `example` status cannot start.
- `name`: nonempty localized display names, with both `en` and `ja` required.
- `contactEmail`, `privacyEmail`: valid addresses used by screens, links and mail.
- `aiUse`: public model history, human translation review scope and the posting
  destination for objections. See [Maintaining the AI-use page](#maintaining-the-ai-use-page).
- `participation.minimumAge`: an integer from 0 to 150. Zero explicitly disables
  age confirmation; other values use the existing age-confirmation record.
- `participation.excludedResidenceCountries`: an explicit array of uppercase
  ISO country codes; an empty array explicitly excludes none.
- `participation.requireTrialConsent`: an explicit boolean. Disabling the
  agreement does not disable the configured age or residence restrictions.
- `participation.trialConsentVersion`, `participation.stanceConsentVersion`:
  positive integers for the independent agreements. Preserve existing versions
  when moving an existing site's unchanged policy. A changed age requirement or
  agreement needs a reviewed consent-version change; records contain an age
  confirmation, not a date of birth.
- `participation.copy`: localized `countryExcluded`, `invitationRestriction` and
  `eligibilitySummary` strings, with `en` and `ja` required. Describe the same
  conditions as the configured age, countries and agreement. Other languages
  fall back to English. Keep these messages plain text.
- `copy`: localized screen wording, with complete `en` and `ja` editions required.
  Missing languages use the complete English edition. These settings are plain
  text, escaped by the screen renderer; HTML is not supported. Every field must
  be present, including fields explicitly set to `null`:
  - `aiRecipient`: recipient phrase inserted into the shared registration
    explanation of AI translation and search (English: "an AI of {aiRecipient}").
    State the processing location consistently with the privacy notice.
  - `stanceDisclosure`, `stanceConsent`: the operator's access policy, shown in
    registration and records, and within the separate stance agreement.
    Storage, aggregation, withdrawal and deletion behavior stays in shared text.
  - `trainingPolicy`: the content-use policy appended to the shared copyright,
    display and translation summary. Include the punctuation needed to join it
    to that language's sentence. Describe provider contracts and training use
    according to the actual operation; the software does not verify contracts.
  - `chatProvider`: provider contracts, retention, processing locations and
    change-notification policy. Include exactly one `{privacy}` placeholder for
    the privacy-notice link. The shared chat explanation separately describes
    translation, context and moderation data sent to AI.
  - `chatProviderChange`: the provider-policy change shown to members whose
    earlier chat agreement predates the current provider-policy disclosure.
  - `termsLabel`, `countryHelp`, `adultError`, `agreementLabel`, `agreementError`,
    `reviewTitle`, `reviewHelp`, `testSiteNotice`: use `null` for the shared
    participation and test-site wording, or provide site-specific wording.
    An overridden `adultError` needs exactly one `{age}` placeholder, filled
    from `participation.minimumAge`. `testSiteNotice` is shown only when
    `TOMOLA_SITE_STAGE=test`; it can describe a site's planned transition.
    Other fields accept no placeholders. Keep labels consistent with the
    site's agreement and use the same participation terminology throughout.

Moving unchanged wording into settings does not change consent versions. Review
any substantive policy change and its consent-version implications separately;
editing copy does not automatically request renewed consent.

Startup validates the complete directory before migrations in Docker and before
accepting requests in the standalone server. Missing settings, invalid types,
missing editions, empty documents, example values and unresolved placeholders
stop startup with an English error. Document placeholders never switch off
participation checks. Settings and documents are read on startup; restart the
server after changing them. `TOMOLA_SITE_STAGE` remains independent.

For Compose, set `TOMOLA_OPERATOR_DIR` to an absolute host directory. Compose
bind-mounts it read-only at `/operator` and sets the container's variable to that
path. A missing host directory is refused rather than created. Ensure UID 1000
can traverse the directories and read the files. For another container launcher,
mount the directory read-only and set `TOMOLA_OPERATOR_DIR` to its container path.
The image contains no site's operating documents.

`pnpm dev` uses the fictional `tests/fixtures/operator/` when the variable is
unset. Unit and browser tests use that fixed fixture too. Supply an explicit
directory to inspect another operator locally; do not use real API keys or mail
recipients for that check.

This guide describes a single-server setup with Docker Compose. It has three parts: PostgreSQL with pgvector, the app (which runs both the web server and the worker), and Caddy for HTTPS and the reverse proxy.

### Maintaining the AI-use page

`/ai-use`, `/ai-use.md` and `/ai-use.txt` are public even when reading posts
requires membership. The current uses, providers, models and selected settings
come from the same resolvers as the calls. The page publishes no API keys,
credentials, service endpoints or prices. It describes configured availability;
individual calls still depend on need and budget, and saved translations can
come from earlier models. Comparison requires a secondary translator, a judge
and a positive comparison sample rate. A secondary translator remains available
as a fallback even when the sample rate is zero.

Every operator directory must include `aiUse`, including when nothing has been
recorded. The complete deployment example contains this empty form:

```json
"aiUse": {
  "history": [],
  "humanReview": null,
  "objectionsUrl": null
}
```

When changing a model, append a `history` entry with:

- `date`: a calendar date in `YYYY-MM-DD` form.
- `purpose`: a stable use ID from the [AI-use registry](../app/lib/ai-use-registry.server.ts),
  such as `translation-primary`. The same registry validates these IDs and
  supplies the page rows.
- `fromModel`, `toModel`: exact model names, copied from the current settings;
  use `null` for a use that was or is disabled. Initial entries can have
  `fromModel: null`.
- `reason`: plain-text localized reasons, with `en` and `ja` required.
- `evidenceUrl`: a public comparison record, or `null` when none is available.

The latest date for each purpose supplies its recorded current model. For
multiple changes on one date, the last entry wins. The page flags an enabled
model without a record, a different model, or a use disabled since its last
record. This warning does not change engine selection or prevent operation.
Record a separate history entry for every purpose that shares the changed model:
`figure-translation` uses the primary translation model, and `report-triage` and
`spam-detection` share the moderation model. A purpose without its own entry
keeps the unrecorded-change warning.

`post-ask` discloses private questions about posts, including the question and
selected readable post and reply originals and translations sent to the provider.
It uses `POST_ASK_AI_MODEL`, defaulting to the primary translation model, and is
shown as not in use when `POST_ASK_AI` is disabled.

Set `humanReview` to localized plain text describing the actual language pairs
and scope people checked, with both `en` and `ja`, or leave it `null` when no
scope has been recorded. Automated tests or model agreement are not human
translation review. Set `objectionsUrl` to a posting destination, such as a
village or the new-post page, or leave it `null` for the general instruction to
raise an objection in a post. The operator responds publicly with reasons.
Other editions of reasons and review scope fall back to English. Links accept
site-relative paths or HTTPS URLs without credentials. Keep secrets and private
records out of all these public fields.

Before upgrading an existing server, prepare a complete operator directory with
the new field. Switch to that directory and restart with the matching app
version; settings are cached for a server's lifetime. After changing a model,
review the live page and both representations for missing-history warnings.
Review provider and data-handling changes under the site's participation and
privacy process separately; recording model history does not update consent
versions.

The guide explains the setup and the procedures. It does not replace the acceptance checks of each deployment. Before inviting members, complete the content and operational checks in section 15, and confirm HTTPS, mail delivery and restoring a backup.

## 1. First start

You need Docker and Compose, public DNS pointing at the server, ports 80 and 443 reachable, SMTP, and a model API under terms that fit how posts are handled. The operator checks the choice of models and the disclosure of what is sent to them.

On the deployment host, fetch the source that has been approved for publication. Create `.env` on that host.

```sh
umask 077
cp .env.example .env
chmod 600 .env
openssl rand -hex 24
openssl rand -hex 32
```

Set the two random values as `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET`. Do not paste the output into conversations, tickets or public logs. In `.env`, change `SITE_ADDRESS` to the host name you operate (for example `forum.example.org`) and `BETTER_AUTH_URL` to its HTTPS URL, and set SMTP, the model API and the operator addresses. Do not use the example values in production.

When updating existing data, do the pre-checks in section 8 first. Even when starting from an empty database, do not disable the startup checks.

```sh
export TOMOLA_REVISION=$(git rev-parse HEAD)
docker compose up -d --build
docker compose ps
curl --fail https://forum.example.org/readyz
```

Replace the host name with the real one. The entrypoint checks the configuration and the review counts of the interface translations, then applies the migrations and starts the server. `/healthz` only shows that the process is alive; it does not check the database or mail delivery. With a test account, check inviting, logging in, registering a passkey, posting and translating.

### Readiness and liveness

External monitoring should request `/readyz`. Its JSON contains
`database` (`ok` or `unavailable`), `worker.enabled`, and, only for enabled
workers, `worker.lastTickAt` (scheduler heartbeat, UTC ISO timestamp or null),
`worker.lastTickCompletedAt` (last completed main tick, UTC ISO timestamp or
null before the first completion), and `worker.currentTickSeconds` (elapsed
seconds in the current main tick, zero while idle). It includes
`oldestDueJobAgeSeconds` (age of the oldest queued job whose scheduled time
has arrived; zero if none, null when the database check fails), `revision`
(full build SHA or `unknown`), and overall `status`. It exposes no member
information or member/post counts. Database opening plus probing is bounded
by two seconds; SQL statements in the probe have a one-second deadline.
Concurrent requests share one database probe and its result is reused for
two seconds, including failures. A timed-out probe retains its slot until
the underlying database wait finishes, preventing a growing probe queue.
Worker metrics are read for each response. Responses use `Cache-Control:
no-store`; the database result cache is local to this process.
Database failure or an absent/at-least-two-minute-old enabled-worker heartbeat
returns 503. Queue age is a metric only: monitoring chooses its threshold.
The heartbeat measures the worker scheduler, including while handlers run
or maintenance pauses new claims. A main tick that never completes remains
visible through a growing `currentTickSeconds` and an unchanged
`lastTickCompletedAt`; monitoring chooses its duration threshold without
making legitimate long jobs return 503. Neither heartbeat nor tick timing
proves that a provider or email service is succeeding. Both `/readyz` and
`/healthz` bypass app access logs.
`/healthz` remains a process-only check for Docker HEALTHCHECK and Caddy, so
an unavailable database does not itself cause a container restart.

**Node image updates:** changing `NODE_VERSION` without a matching
`NODE_IMAGE_DIGEST` still builds the old, digest-pinned image. Update both.

## 2. Environment variables and secrets

Only the empty values and generic examples in `.env.example` go to GitHub. The real `.env` is never pushed. In the supplied Compose file, `env_file: .env` loads the file on the deployment host into the container environment at run time. `.dockerignore` keeps `.env` out of the build context, so it is never copied into the image. On other deployment services, register the same variables in that service's secret or environment settings.

| Variable | Setting at deployment |
| --- | --- |
| `POSTGRES_PASSWORD` | Database password for Compose. It is embedded in a URL, so use a hex random value |
| `SITE_ADDRESS` | Public host name for Caddy |
| `BETTER_AUTH_URL` | The HTTPS URL people actually open. The basis for passkeys and origin checks |
| `BETTER_AUTH_SECRET` | A sufficiently random value of at least 32 characters. Do not change it casually once in use |
| `MAINTENANCE_FLAG_FILE` | Presence pauses new worker claims and rejects unsafe HTTP methods with 503 and `Retry-After: 30`; default `/tmp/tomola-maintenance`. Keep on container-local `/tmp` so replacement starts writable |
| `REVISION`, `TOMOLA_REVISION` | Docker build SHA (default `unknown`). Compose passes `TOMOLA_REVISION` to build argument `REVISION` and uses it for the `tomola-app` image tag. Keep the runtime `REVISION` equal to the image build |
| `TOMOLA_HOME_TRIAL` | `1` shows the isolated home-trial banner. Requires `TOMOLA_ALLOW_FAKE_ENGINES=1`, fake engines and no real model keys; never use on a member deployment |
| `TOMOLA_SITE_STAGE` | `test` adds a test-site notice to every HTML page and a localized prefix to every outgoing mail subject. Empty or unset disables both; other values are rejected at startup. Leave unset in production and ordinary local development |
| `DATABASE_URL` | Compose sets the URL of the internal database. Set it yourself for an external database |
| `DATABASE_POOL_MAX` | PostgreSQL connections per process, integer `1` to `100`, default `10`. Allow room for migrations, operator commands and other processes within the server's connection limit |
| `TRANSLATION_CONCURRENCY` | Public-post translation jobs per process, integer `1` to `8`, default `2`. Mail, embeddings and maintenance use a separate serial lane; chat retains its own slots |
| `SMTP_URL`, `MAIL_FROM` | Mail delivery connection and sender. Treat the credentials as secrets |
| `MAIL_DECOY_TO` | Required when `SMTP_URL` is set (startup refuses otherwise). An address the mail provider accepts and does not deliver; for Postmark, `test@blackhole.postmarkapp.com`. A login request for an address that must never receive mail (an invited address held after a suspended departure) sends one ordinary-looking login mail here, with a code and link that are not real, so the request takes the same path and time as any other. The held address is never mailed or logged. Each decoy mail counts toward the provider's monthly sending volume and appears in its activity log with the decoy as recipient. Not used without SMTP (development mail goes to the log, decoy included) |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Set only the keys of the model providers you use |
| `TRANSLATION_PRIMARY`, `EMBEDDING_ENGINE` | Real engines for a deployment with members. Do not use fake |
| `TRANSLATION_SECONDARY`, `DIVERGENCE_JUDGE` | Optional comparison and fallback engines. Off by default |
| `TRANSLATION_GEMINI_MODEL` | Primary Gemini translation model; default `gemini-3.5-flash-lite` |
| `TRANSLATION_SECONDARY_GEMINI_MODEL`, `DIVERGENCE_JUDGE_GEMINI_MODEL` | Models for explicitly enabled Gemini secondary and judge roles; both default to `gemini-3.6-flash`, distinct from the default primary model. When overriding the primary, select different secondary and judge models |
| `ENABLED_LANGS` | Language tags to open. Only languages whose interface strings have no missing, stale or untranslated entries |
| `PREVIEW_LANGS` | Languages opened as a preview with unchecked machine translations. Empty means no preview. A subset of `ENABLED_LANGS`; `ja` and `en` are not allowed |
| `OPERATOR_EMAILS` | Accounts that can open the operator screens, such as usage |
| `OPERATOR_ONLY_INVITATIONS` | `1` limits invitation creation to operators listed in `OPERATOR_EMAILS`. Empty or unset also lets members create invitations. Any other value is a startup error. Existing unused invitations remain valid after switching; operators can revoke them from `/admin/invitations` |
| `MODERATION_SPAM_ENABLED` | `1` enables deterministic spam/abuse hiding on new posts, replies and chat messages; default closed. Repetition requires at least 20 normalized characters within 10 minutes; symbol-only messages do not count. Chat repetition and rapid posting cannot hide messages without an additional link or promotion signal. Existing request rate limits remain in force. Enable only after publishing the privacy explanation |
| `MODERATION_AI_SPAM_ENABLED` | `1` additionally enables queued AI classification of suspicious public writing. Requires `MODERATION_SPAM_ENABLED=1`; default closed. Chat bodies never enter this classifier. Only a strictly valid spam verdict with confidence at least 0.98 can trigger the deterministic hiding policy |
| `MODERATION_AI_TRIAGE_ENABLED` | `1` enables queued AI report priority and assessments; default closed. AI never decides a report's disposition. Chat target and context authors must each have accepted chat consent version 2 or later in that village. Without target consent no chat text is sent. The initial window contains at most 10 existing messages on each side, with nonconsenting authors omitted. AI reads are recorded in `chat_access_log` with model, exact versions and ranges |
| `FIGURE_TRANSLATION` | Optional translated figures: `1` enables reading image labels and rendering their translations; unset or `0` keeps original images and makes no figure calls. Enable only after the privacy notice covers sending posted images to the selected AI provider |
| `FIGURE_READING_MODEL` | Optional vision-capable model from the primary translation provider. Defaults to its light model (`gemini-3.5-flash-lite` or `claude-haiku-4-5`); startup rejects a provider mismatch. Figure reading and label translation share the public monthly budget and translation queue. The runtime contains the Regular and Bold Noto Sans, Noto Sans Thai and Noto Sans CJK faces. Both weights are required at startup and before each rendering job, even for figures without bold labels. Missing fonts fail the pre-migration startup check and jobs retry; unsupported characters retain the original figure |
| `MODERATION_AI_MODEL` | Model from `TRANSLATION_PRIMARY`'s provider and credentials; Gemini default `gemini-3.5-flash-lite`, Claude default `claude-haiku-4-5`. Startup rejects a provider mismatch and moderation switches other than `1`, empty or unset. The fake provider makes no network calls. Usage purpose `moderation` shares the public monthly budget, including chat report triage; no separate cap. Budget pauses defer jobs; deterministic detection keeps working. Disabling an AI switch defers existing jobs for one hour without new calls. Enable after disclosures and consent text are in place |
| `LLM_MONTHLY_BUDGET_USD` | Non-negative finite monthly USD accounting limit, default `20`; `0` pauses calls. Invalid values stop production startup. Not a billing cap at the provider |
| `VILLAGE_CHAT` | `1` enables member-only village chat; empty or unset keeps it closed. Requires `VILLAGES=1`; any other value is a startup error. Consent, reports/moderation and translation are implemented. Before enabling it on a site, complete a legal review of the communications rules that apply there |
| `CHAT_TRANSLATION_MODEL` | Chat model of the primary translation provider; defaults to `gemini-3.5-flash-lite` for Gemini, independently of the public-post model. The existing fake-provider switch applies to chat in tests |
| `CHAT_TRANSLATION_THINKING` | Chat thinking: `off` (default), `low`, or `default`; independent of public-post thinking |
| `CHAT_TRANSLATION_CONCURRENCY` | Integer from `1` to `16`; maximum simultaneous chat translation jobs per worker process, default `4`. Public-post jobs use their own loop. Provider calls do not hold DB transactions; jobs share the existing bounded connection pool |
| `CHAT_LLM_MONTHLY_BUDGET_USD` | Separate chat accounting limit per UTC month, default `2`; `0` pauses chat translations. Public-post accounting excludes chat. Reservations count against this cap before calls start. Paused jobs recheck within 15 minutes and at the next month boundary. This is not a provider billing cap |
| `VILLAGES` | `1` enables village membership and topic placement. Empty or unset keeps the existing behavior. Any other value is a startup error. Prepare existing data before enabling (see Village preparation below) |
| `PUBLIC_READING` | `1` lets anyone read posts and lists without logging in. Empty or unset means members only. Any other value is a startup error. Writing, stances, search and the like still require login |
| `SOURCE_URL` | Where the source corresponding to the running version is published. HTTPS, without credentials |

Operators can paste up to 20 addresses into `/invites/new` and send recipient-bound invitation emails using the existing mail transport and an enabled language chosen for that batch. Email delivery is selected by default; operators can turn it off to copy individual links, while ordinary member invitations remain single-address links delivered by the member.

Chat translation settings are validated only when `VILLAGE_CHAT=1`. Chat translations use only the same village's two preceding visible original messages within ten minutes as untrusted context. Deleted and hidden messages are excluded; messages retained after a member leaves remain eligible. Translation changes share the message change cursor. SSE carries only a change signal within one process; periodic fetches synchronize changes made by another process. Access, consent and moderation gates are implemented. Before enabling chat on a site, complete a legal review of the communications rules that apply there.

Chat translation error reports are limited to consenting village members, excluding the author, at 30 reports per member per hour. The first report for a message/language queues one regeneration using the chat model, context and glossary. Unchanged or failed output, and later reports, go to target-language moderators at `/mod/chat-translations`. GET returns metadata; opening the original and translated snapshots requires POST and writes `chat_access_log`. Moderators can hide the reported translation or dismiss the report. Existing cases remain available if chat is subsequently closed. Original/translation snapshots and notes are cleared 180 days after the report is handled; case metadata remains.

Reading rate limits (browser, API, MCP and public reads) also use process-local memory, requiring a single application process; write limits remain in the database.

Keep backups of the secrets private as well, with restricted permissions and encryption. `docker compose config`, `docker inspect` and environment listings contain secrets; do not paste them into public material. After changing the configuration, recreate the app container and confirm that the change took effect.

## 3. Proxies and TRUSTED_PROXY_HOPS

The supplied setup exposes only Caddy; the app and database ports are not published. With one Caddy in front, set `TRUSTED_PROXY_HOPS=1`. If you add a CDN or another proxy in front, check that the sources Caddy trusts and the actual number of hops agree. Publishing the app port directly creates a path on which forwarding headers can be forged.

Make the host name, `BETTER_AUTH_URL` and the forwarded Host agree. Match the request body limit of the app (`MAX_REQUEST_BODY_BYTES`) with Caddy's limit.

## 4. Models, budget and glossary

Use keys under terms that match the range of posts sent to external providers, their conditions on storage and training, and what you disclose to members. Check model names, prices and terms at the time you operate. This guide does not state fixed prices or any provider's data-use guarantees.

Choose the primary engine, and if needed the secondary engine and the judge, and the model for re-translation after a mistranslation report. `TRANSLATION_RETRY_MODEL` uses a model from the same provider as the primary engine. The secondary engine and the judge are off by default; set them explicitly only when you compare.

The app reports settled usage per UTC month; active reservations do not change the displayed budget state or appear in the usage breakdown. At 80% of settled usage it stops secondary, judge and report-retry calls; primary translation and embeddings continue while their estimates fit. Admission checks include outstanding reservations and are atomic across concurrent workers. A call whose estimate would exceed the remaining budget waits with an insufficient-capacity reason while retaining the current budget-state label. Each provider request has a two-minute deadline and no SDK retries. Charged responses replace their reservation with actual usage; uncharged failures release it. A usage-write failure retains the reservation and retries settlement without repeating the provider call. Reservations count across UTC month boundaries for at most ten minutes. The worker's maintenance tick finalizes older reservations at their estimated amount in their creation month, so unknown outcomes after a crash cannot block later months indefinitely. A late actual settlement can still replace that estimate. This is not a hard cap on provider billing: configured prices and token estimates can differ from the invoice. Set provider billing alerts and limits too.

Translation jobs stop after two total job attempts for truncated output and three for empty or invalid output, bounded further by the job's own attempt limit. When the secondary engine is available and permitted by the budget, primary failures can trigger fallback from the fourth attempt or the final permitted attempt, whichever is earlier; primary refusal can trigger it immediately. Fallback adds model calls within the same job attempt. Refusal without an available fallback and persistent output leaks remain terminal immediately. Configuration errors retain the job's configured limit. Charged failures still enter the usage ledger.

Once daily, failed publication/title translation jobs caused by rate limits, provider outages, timeouts, network errors or budget limits are reconsidered for still-visible posts at the same source version. They resume only while the budget permits, at most three times per post/language/version, with compact counter records retained across execution-log cleanup. Refusal and invalid translation output are excluded; report-driven retranslation keeps its separate moderation policy.

With `TRANSLATION_EAGER_SCOPE=readers` (the default), `pnpm translations:requeue` recovers only pairs with a failed translation job at the current source version or a current primary translation suppressed from display. Failed title-only jobs requeue only the title; never-requested pairs and provisional titles alone do not request missing bodies. Failures whose job records have expired under `cleanup_jobs` retention require previewing `--all-missing --lang <tag> --dry-run` before running without `--dry-run`. With `TRANSLATION_EAGER_SCOPE=all`, the default remains every pair missing usable current primary output. `--all-missing` explicitly selects that broader scope under either policy. `--include-flagged` also retries displayed near-copy results; `--divergence` also queues eligible unmeasured comparisons. `--lang <tag>` restricts work to an enabled language and may be repeated. Preview targets with `--dry-run`, which reports pair and source-character counts without queuing work:

```sh
pnpm translations:requeue --lang fr --dry-run
pnpm translations:requeue --all-missing --lang fr --dry-run
```

Run again without `--dry-run` after reviewing the scope. These commands require a configured primary engine; fake development engines still require `--allow-fake`. `pnpm langs:open <tag>` continues to cover all missing pairs in that language, including its dry-run estimate.

PostgreSQL pool connections wait at most 10 seconds for acquisition, run statements for at most 30 seconds, and close idle transactions after 60 seconds. Migrations use no statement deadline and a 10-second `lock_timeout`, including the migration advisory-lock connection. Operator scripts use a separate connection with the statement deadline disabled: migrations, site/glossary exports, glossary import, village preparation/checks, language opening, translation requeue, embedding/reference/render rebuilds, passkey recovery, invitations and media deletion. These connections retain acquisition and idle-transaction limits. A worker stops new claims immediately on shutdown, lets all lanes drain for eight seconds by default, then aborts unfinished handlers and requeues them without consuming an attempt.

Import the initial glossary as an operator after reviewing its contents. Replace `<handle>` with the handle of a real operator.

```text
docker compose exec app pnpm glossary:import docs/drafts/glossary-initial.yaml --as <handle> --dry-run
docker compose exec app pnpm glossary:import docs/drafts/glossary-initial.yaml --as <handle>
```

Review the dry run first, then import. Checking the interface translations and checking the glossary are separate tasks.

## 5. Backup and restore

The database contains posts, email addresses, and authentication and moderation
records. Keep backups private. A plain copy of a live volume is not a logical
backup. The host-side scripts use the running Compose services:

```sh
# Example: retain 10 completed dumps in backups (script defaults: backups, 7).
pnpm db:backup backups 10
# Without pnpm on the host:
bash scripts/backup-db.sh backups 10
# Use the exact dated filename printed by the backup command.
pnpm db:restore-check backups/tomola-<UTC-timestamp>-<pid>.dump
```

If deployment uses Compose overrides or a non-default project name, prefix
these host-side scripts with the same `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME`
settings used for deployment (for example,
`COMPOSE_FILE=docker-compose.yml:compose.override.yml bash scripts/backup-db.sh backups 10`).


`scripts/backup-db.sh` uses `pg_dump -Fc`, private file permissions, a unique
UTC filename, and `pg_restore --list` before publishing the dump or pruning
older completed dumps. Partial or unverifiable dumps are removed without
pruning older backups. `scripts/restore-check.sh` creates a disposable database,
restores with errors fatal, applies the deployed app's migrations, and checks
that entries and jobs can be queried. It drops only its generated disposable
target, including on failure. It does not overwrite the member database or
start workers, mail delivery or model calls. The Compose database user must
be able to create databases and the vector extension.

The retention count is a deployment choice. Always pass it explicitly and make the backup schedule, command argument and published privacy notice agree. The script defaults to seven completed dumps; `RETENTION.backupGenerations` declares ten but does not configure the shell script or backup rotation. The examples above explicitly retain ten. A generation count is not a fixed number of days.

Copy backups to a separate location as an additional protection. Schedule,
remote copying and encryption are deployment choices outside these scripts.
Regularly exercise restoring, and separately check inviting, login, posting
and translation in an isolated configuration. Keep private backups as needed
of `.env`, `BETTER_AUTH_SECRET`, the host-name record and Caddy certificate
data. Losing or changing the authentication secret or host affects links and
passkeys.

## 6. Updating and rollback

During maintenance, AI-client reads over MCP and OAuth token refreshes are
also unavailable for a few minutes because those operations use POST.

1. Pin the approved source revision; inspect changed migrations and section 8.
2. Place the read-only flag in the **running old container**:
   `docker compose exec app touch /tmp/tomola-maintenance` (use the configured
   `MAINTENANCE_FLAG_FILE` path if different). Unsafe methods, including login
   and authentication, return 503 with a short explanation and retry header.
   GET, HEAD and OPTIONS remain available. Flag checks are cached for at most
   one second. All worker lanes stop new claims; running jobs finish and
   completion/usage bookkeeping continues. Allow that cache interval and
   already accepted write requests to finish. Check completed HTTP requests
   in the app log and wait for zero running jobs, for example with
   `docker compose exec db psql -U tomola -d tomola -c "SELECT count(*) FROM jobs WHERE status = 'running';"`.
3. Run `pnpm db:backup backups 10`. Keep that exact pre-update dump. If backup
   or draining fails, keep the flag in place and investigate before updating.
4. Set `export TOMOLA_REVISION=$(git rev-parse HEAD)` and run
   `docker compose build app`. Do not pass production API keys to the build.
   The image is tagged `tomola-app:<SHA>`; retain the previous tagged image.
5. Run `docker compose up -d --no-build --force-recreate app`. The new
   container's `/tmp` has no maintenance flag. Check startup, migrations,
   `/readyz`, the footer SHA and operations with a test account. If needed,
   put the flag into the new container while investigating.
6. When `RENDER_VERSION` changes, inspect
   `docker compose exec app pnpm render:rebuild --dry-run`, then run without
   `--dry-run`. This calls no model API. Check the queue in operator screens.

To abandon an update before replacement, remove the old container's flag:
`docker compose exec app rm /tmp/tomola-maintenance` after checking its state.
If a replacement fails before serving, the old stopped container's flag is
still present; deliberate removal is required when restarting that container.

Before either rollback path, check the current preservation case record with
the application and workers stopped. An image from before preservation support
does not honor `retention_hold`: if a hold is active or preservation is required,
disable its cleanup before starting it. Use a Compose configuration override
with the app's `WORKER_ENABLED: "false"` and retain it throughout the hold (the
supplied Compose file sets it to `"true"`). If the old image cannot disable
workers, keep it stopped. A database hold alone cannot protect against old code.
See [older-image recovery](runbooks/retention.md#rolling-back-to-an-image-without-preservation-support)
for status checks and the separate no-preservation cleanup path.

If **no migration changed the database**, select the previous image by its
recorded SHA (and keep its matching configuration):

```sh
export TOMOLA_REVISION=<previous-full-SHA>
docker image inspect "tomola-app:$TOMOLA_REVISION"
# Include the worker-disabled Compose override here when preservation requires it.
docker compose up -d --no-build --force-recreate app
curl --fail https://forum.example.org/readyz
```

Migrations move forward only. If a migration changed the schema or data,
switching the image does not undo it. Stop writes and the app, restore the
pre-update dump into a separate empty recovery database, and validate it offline
with operator commands from the matching old image, keeping the application and
workers stopped, before selecting that database through a Compose
configuration override of `DATABASE_URL`. Do not run the current migration
code on that recovery database before starting the old image. Keep the
failed database for investigation; do not start by overwriting it. Restore
loses writes after the backup, which is why draining precedes that backup.
The stop grace period must exceed HTTP and worker shutdown limits.

For a retention-capable image matching the restored schema, follow the procedure
below. For an older image without these commands, follow the older-image recovery
instructions above; do not apply current migrations just to run these commands
and then start the old image.

After restoring a database, keep the application, workers and member traffic
stopped. Restored `cleanup_jobs` can have an overdue `run_at` and execute as
soon as workers start. Check the current preservation case record before any
cleanup; the backup's hold state may be obsolete. Follow this order using an
operator shell with the restored database configuration:

```sh
# 1. Do not start the application or workers.
# 2. Inspect the restored hold state and the current preservation case record.
pnpm exec tsx --env-file-if-exists=.env scripts/retention.ts status
# 3. Choose preservation when required; never run cleanup in this branch.
# Set this explicitly from the current case record, not the restored hold state.
PRESERVATION_REQUIRED=yes
if [ "$PRESERVATION_REQUIRED" = yes ]; then
  pnpm exec tsx --env-file-if-exists=.env scripts/retention.ts hold --reason "Preservation case reference"
elif [ "$PRESERVATION_REQUIRED" = no ]; then
  # 4. Only after confirming there is no current preservation request.
  pnpm exec tsx --env-file-if-exists=.env scripts/retention.ts run
fi
# 5. After the chosen branch succeeds, start the application and workers.
# Complete any deferred cleanup before reopening member traffic.
```

An active hold prevents cleanup; preserve it rather than releasing it to
complete a restore. If the no-preservation branch refuses an obsolete hold,
resolve it using the authorized release procedure before retrying. Review each
category's remaining count and repeat `run` for capped, timed-out or locked backlogs before
reopening traffic. Restored dumps can contain records already purged from the
live database. See [retention operations](runbooks/retention.md)
for hold commands, batch limits and recovery from an older schema/image.

The supplied app has a read-only root filesystem, with a 512 MiB `/tmp`
tmpfs. Normal server/image processing uses PostgreSQL and temporary buffers;
Corepack and its native pnpm binary are prepared in `/opt/corepack` during
build, with runtime downloads disabled. Operator commands that produce files
(site exports and translation comparisons) must target `/tmp` and copy their
output out with `docker compose cp`, or use an explicitly writable output
mount. An unmounted relative output directory under `/app` is read-only.
Verify startup, migrations, sharp image conversion and a pnpm operator command
on the deployment host before rollout; these container behaviors cannot be
established by source inspection alone.

### Updating pinned base images

Node, pgvector/PostgreSQL and Caddy retain readable tags and pin a multi-platform
index digest. Fetch the new digest from the official registry, review its
version, platforms and upstream changes, then change the digest in Dockerfile
or Compose through a pull request. Rebuild and verify the resulting containers;
changing a tag without its digest does not update the pinned image. Changing
`NODE_VERSION` also requires a matching `NODE_IMAGE_DIGEST`.

## 7. Passkeys and the host name

Passkeys are bound to the host name of the site where they were registered. Signing posts is chosen by each member in settings and is off by default. Changing the signing setting and deleting a passkey always require a signature, whatever the signing setting is. Before enabling member access, in a real browser whose certificate matches the host name, check passkey login, and turning the signing setting on, posting, and turning it off again. Keep the same host name across deployment changes. Changing the host name requires guidance to members that includes logging in again by email and registering passkeys again.

## 8. Database

### pgvector (permission for `CREATE EXTENSION vector`)

Migration `0036` runs `CREATE EXTENSION IF NOT EXISTS vector`.
- With the supplied setup (`pgvector/pgvector:pg18`, where `POSTGRES_USER` is a superuser), it simply works.
- On managed databases (RDS, Cloud SQL, Supabase and so on) or with a user without the permission, it fails. On `permission denied to create extension` or `extension "vector" is not available`, `pnpm db:migrate` stops with the reason and what to do. Enable the extension once as an administrator (or in the service's console) with `CREATE EXTENSION IF NOT EXISTS vector;`, and run the migrations again. pgvector 0.8 or later (for `hnsw.iterative_scan`, so that search returns 20 results) and PostgreSQL 17 or later (migration `0041` uses `SET EXPRESSION`) are assumed (tested with PostgreSQL 18.6 and pgvector 0.8.6).

### Encoding and collation (ICU locales)

- Create the database in UTF8 (the `normalize()` in the migrations needs UTF-8). The default database of `pgvector/pgvector:pg18` is UTF8.
- For the unique key of usernames (`profiles.handle_key`), the app's computation (NFKC normalization, lower-casing character by character, NFKC again) is authoritative. Migration `0025` fills existing rows with PostgreSQL's `lower()`, which depends on the database collation. The two can disagree under ICU locales and the like (for example "İ"). So after the migrations, `pnpm db:migrate` corrects only the keys that disagree, using the app's computation (if that causes a collision, it fails and names the usernames: rename them and run it again). The choice of database locale (C, `en_US.UTF-8`, ICU `en-US`) therefore does not affect the uniqueness of usernames. Optional display names are not unique. Tested with ICU `en-US` and the `C.UTF-8` ctype.
- Collation also affects sorting (`ORDER BY` on strings), but the app does not order display names or the like by string order.

### Pre-check for 0012 (when bringing in existing data)

Migration `0012` (`0012_enum_checks`) adds CHECK constraints to the enumerated columns. **A new (empty) database needs nothing.** In a database that holds data from another environment (rows made by hand, for example), `0012` fails if any row breaks a constraint. Beforehand, confirm that the following SELECT returns 0 rows:

```sql
SELECT 'entries.kind' AS c, id::text FROM entries WHERE kind NOT IN ('topic','reply')
UNION ALL SELECT 'entries.lang', id::text FROM entries WHERE lang NOT IN ('ja','en','fr','de','zh-Hant','zh-Hans','ko','th','vi')
UNION ALL SELECT 'entries.ai_assistance', id::text FROM entries WHERE ai_assistance NOT IN ('none','polish','draft','coauthor')
UNION ALL SELECT 'entries.via', id::text FROM entries WHERE via NOT IN ('web','api')
UNION ALL SELECT 'profiles.home_area', user_id FROM profiles WHERE home_area NOT IN ('ja','en','fr','de','zh-Hant','zh-Hans','ko','th','vi','other')
UNION ALL SELECT 'translations.field', id::text FROM translations WHERE field NOT IN ('title','body')
UNION ALL SELECT 'translations.lang', id::text FROM translations WHERE lang NOT IN ('ja','en','fr','de','zh-Hant','zh-Hans','ko','th','vi')
UNION ALL SELECT 'translations.kind', id::text FROM translations WHERE kind NOT IN ('primary','secondary','author','human')
UNION ALL SELECT 'jobs.status', id::text FROM jobs WHERE status NOT IN ('queued','running','done','failed')
UNION ALL SELECT 'divergences.severity', id::text FROM divergences WHERE severity NOT IN ('low','medium','high')
UNION ALL SELECT 'translation_reports.status', id::text FROM translation_reports WHERE status NOT IN ('open','resolved')
UNION ALL SELECT 'llm_usage.purpose', id::text FROM llm_usage WHERE purpose NOT IN ('translate','judge','embed')
UNION ALL SELECT 'drafts.kind', id::text FROM drafts WHERE kind NOT IN ('topic','reply')
UNION ALL SELECT 'drafts.via', id::text FROM drafts WHERE via NOT IN ('web','api');
```

(Later migrations behave the same way: `0040` (`drafts_token_via_check`) fails if a draft with `via = 'web'` has a `token_id`: `SELECT id FROM drafts WHERE via <> 'api' AND token_id IS NOT NULL`.)

(From `0042` on, `author` is removed from `translations.kind`. The SELECT above checks the constraints as of `0012` and still allows `author`; use it as is when running `0012`. `0042` deletes the `author` rows; see "Pre-check for 0042" below.)

`0041` (`0041_questions`) adds columns (`asks_stance`, `alt_of`, `stance_tag`, `stance_locked_at`, `meta_changed_at`) and constraints to `entries`, and changes the expression of the generated column `changed_at` with `ALTER COLUMN … SET EXPRESSION` (PostgreSQL 17 or later). This rewrites every row of `entries` and its indexes under an exclusive lock, so on a database with a lot of data, stop the app before running it. Every existing row satisfies the new constraints (the new columns take their defaults or null), so no pre-check is needed.

`0043` (`0043_stances`) adds the tables `stances` and `stance_changes`, the exclusion columns of `profiles` (`reactions_excluded_at`, `reactions_excluded_action_id`) and the column `revision_id` of `moderation_actions`, and rebuilds the CHECK constraint of `moderation_actions` (the action kinds `exclude_reactions`, `include_reactions`, `fix_entry`, `unfix_entry`). The new tables are empty and every existing row satisfies the new constraints (the moderation records are a small table, so rebuilding the constraint takes a moment), so no pre-check is needed. No setting needs to be added.

### Pre-check for 0042 (deleting author translations)

Migration `0042` (`0042_remove_author_translations`) **deletes the author translations (`translations.kind = 'author'`) and their history (`translation_revisions` with `kind = 'author'`, or with `reason` `author_translation` or `author_deleted`)**, and removes `author` from the CHECK constraint (it also adds the columns `route`, `source_hash` and `retry_slot` and a unique index to the table of mistranslation reports, and allows `retry` in `llm_usage.purpose`). Deleted author translations cannot be recovered. **In a database that has author translation rows or history, the migration stops without deleting anything unless the confirmation mark is present** (the session setting `tomola.allow_author_delete = on`; see the procedure below). **A database with no matching rows needs no confirmation mark.** The guard depends on rows, including synthetic fixtures, not an operational stage. Before migrating any database with existing data, take a backup (section 5) and run the following SELECTs. If matching rows exist, stop for an operator decision about preserving or deleting them; offer affected authors an export before authorizing deletion:

```sql
SELECT kind, count(*) FROM translations GROUP BY kind ORDER BY kind;
SELECT count(*) AS author_rows, count(DISTINCT entry_id) AS entries, min(created_at), max(created_at) FROM translations WHERE kind = 'author';
SELECT reason, count(*) FROM translation_revisions WHERE kind = 'author' OR reason IN ('author_translation', 'author_deleted') GROUP BY reason;
```

`author_rows` in the second SELECT must be 0 and the third must return 0 rows. If so, nothing is needed (it runs without the mark). If not, stop and tell the operators. Only if the operators still decide that the rows may be deleted, take a backup and run it with the mark:

```
PGOPTIONS="-c tomola.allow_author_delete=on" pnpm db:migrate        # PostgreSQL, run from a local shell
TOMOLA_ALLOW_AUTHOR_DELETE=1 pnpm dev                                 # development PGlite data (when it may be deleted)
```

With Docker, the app's entrypoint runs the migrations, so add `PGOPTIONS=-c tomola.allow_author_delete=on` to `.env` **once**, run `docker compose up -d`, and remove the line after the migration has finished.

Without the mark, the migration stops with the error `migration 0042 deletes author translations (N rows in translations, M in translation_revisions) and nothing was changed …` (nothing has been changed partway: this check is the first statement). Existing open mistranslation reports remain (`route` defaults to `moderator`, `retry_slot` to false) and appear in the moderators' list (`/admin/translations`).

### Pre-check for `titleless_topics` (CHECK constraints for topics without a title)

Migration `titleless_topics` adds three CHECK constraints to `entries`: a title is not an empty string (`entries_title_not_blank_check`), a topic that asks for stances (`asks_stance`) has a title (`entries_question_title_check`), and only topics have titles (`entries_reply_title_check`). **A new (empty) database, or data created only by this app, needs nothing** (topic titles have always required at least one character, and replies never had a title). In a database that holds data from another environment (rows made by hand, for example), the migration fails if any row breaks a constraint. Beforehand, confirm that the following SELECT returns 0 (if not, do not run it; stop and tell the operators):

```sql
SELECT count(*) FROM entries
WHERE (title IS NOT NULL AND btrim(title) = '') OR (asks_stance AND title IS NULL) OR (kind <> 'topic' AND title IS NOT NULL);
```

No constraint is added to `drafts` (a draft may be unfinished).

### Pre-check for 0047 (deleting votes)

Migration `0047` (`0047_delete_votes`) **deletes every row of the table `votes`**. Votes (agreement) become "Insightful" (the reader gained a new perspective); because the meaning changes, the existing rows are deleted rather than counted. The table, the column (`voter_area`), the primary key and the rule (you cannot press it on your own post) are reused as they are. Deleted rows cannot be recovered. **In a database that has vote rows, the migration stops without deleting anything unless the confirmation mark is present** (the session setting `tomola.allow_vote_delete = on`; see the procedure below). **A database with no vote rows needs no confirmation mark.** For any populated database, take a backup (section 5), inspect the following counts, and obtain an operator decision before deleting votes. Synthetic test rows are subject to the same guard:

```sql
SELECT count(*) AS votes, count(DISTINCT voter_id) AS voters, min(created_at), max(created_at) FROM votes;
SELECT p.handle, count(*) FROM votes v JOIN profiles p ON p.user_id = v.voter_id GROUP BY p.handle ORDER BY 2 DESC;
```

If `votes` in the first is 0, nothing is needed (it runs without the mark). If not, identify whether the rows are synthetic fixtures or actual member choices and record the counts privately. Do not treat actual choices as disposable test data. Only if the operators still decide that the rows may be deleted, take a backup and run it with the mark:

```
PGOPTIONS="-c tomola.allow_vote_delete=on" pnpm db:migrate        # PostgreSQL, run from a local shell
TOMOLA_ALLOW_VOTE_DELETE=1 pnpm dev                                 # development PGlite data (when it may be deleted)
```

With Docker, the app's entrypoint runs the migrations, so add `PGOPTIONS=-c tomola.allow_vote_delete=on` to `.env` **once**, run `docker compose up -d`, and remove the line after the migration has finished.

Without the mark, the migration stops with the error `migration 0047 deletes the votes, which meant agreement (N rows in votes) and nothing was changed …` (nothing has been changed partway: this check is the first statement).

### `home_stream` (rendering of home cards and indexes)

Migration `0051_home_stream` adds the columns `entries.card_html` and `translations.card_html` (both `text`, nullable; a rendering of only the opening of a topic's body) and three partial indexes for the "new posts" order of the home (`entries_topic_created_idx`, `entries_question_created_idx` (questions only), `entries_titled_created_idx` (long posts only, that is, topics with a title)). **Nothing needs to be checked beforehand** (it only adds columns and indexes and does not rewrite existing rows). With existing data, allow for writes waiting while the indexes are built when you update.

Existing rows keep `card_html` as NULL. **This change raised `RENDER_VERSION` (`app/lib/markdown.server.ts`)** (the rendering result gained the opening-only version), so every stored rendering becomes a row of a different version and is a target of re-rendering under "6. Updating" above. Lists opened before re-rendering has finished re-render rows of a different version when they are displayed and store them (`loadOriginalCards` for lists, and `translationRender` in `entry-display.server.ts`). This is only slower; it does not cause errors.

### Pre-check for 0048 (making `ai_assistance` optional)

Migration `0048` (`0048_ai_assistance_optional`) removes the default (`none`) and NOT NULL from `entries.ai_assistance` and `drafts.ai_assistance`, and **rewrites `none` to NULL (not stated) on rows written from the screens (`via = 'web'`)**. The reason: the field on the screens used to start as `none`, so a `none` in a row cannot be told apart from a value the author chose. Rows with `via = 'api'` keep their values (in the API, too, a `none` the author wrote in frontmatter cannot be told apart from a `none` the API filled in when nothing was written, so it is kept). Values other than `none` (`polish`, `draft`, `coauthor`) are not changed on any row. Rewritten values cannot be restored. **An empty database has no values to rewrite.** For any populated database, take a backup (section 5), inspect these counts and obtain an operator decision about the rewrite:

```sql
SELECT via, ai_assistance, count(*) FROM entries GROUP BY 1, 2 ORDER BY 1, 2;
SELECT via, ai_assistance, count(*) FROM drafts GROUP BY 1, 2 ORDER BY 1, 2;
```

The rows with `via = 'web'` and `none` are the ones that become NULL. The stored data cannot distinguish an explicit choice from the old default. If actual member choices must be preserved, stop and arrange their preservation before running this irreversible rewrite; an environment label does not recover that information. After the migration, posts that state `ai_assistance: none` in frontmatter or through the API get `none` and are distinguished from posts without a value. The operator metrics (`/admin/metrics`, `/admin/observation`) count only posts with a value and show the number of posts without one separately.

### Pre-check for the new default of notification email

Migration `follows_notifications` adds `auto` to the notification email setting `profiles.email_pref` and makes it the new default, and **rewrites every member with `daily` to `auto`** (members left at the default cannot be told apart from members who chose `daily`). `auto` sends reply notifications right away (after a 5-minute wait) and everything else (new replies in followed topics, moderation, appeal results) as a daily digest. Members with `immediate` and `none` are unchanged. For rewritten members, reply notifications change from the daily digest to immediate email. **Before running it**, check the distribution of values with the following SELECT and keep it in the work report:

```sql
SELECT email_pref, count(*) FROM profiles GROUP BY 1 ORDER BY 1;
```

An empty database has no preferences to rewrite. For synthetic fixtures, confirm that resetting their preferences is acceptable. For any database with actual accounts, tell the operators how many `daily` preferences will change and confirm the rewrite before running it. Whether a value was a default or an explicit choice was not stored, regardless of deployment stage. Back up before migrating; if actual choices must remain, arrange preservation before running this rewrite. The same migration adds the columns `thread_id` and `merged_count` to `notifications` and creates the table `follows` (follows are not backfilled for existing posts; they take effect from posts created from now on).

### Pre-check for user names (0056)

`0056_ascii_usernames` restricts user names to lower-case ASCII letters, digits, `_` and `-` (2 to 30 characters, starting with a letter or a digit). If existing rows do not match, the migration stops; it does not rename anyone automatically. Before the migration, run the following and confirm that it returns no rows.

```sql
SELECT user_id, handle
FROM profiles
WHERE handle !~ '^[a-z0-9][a-z0-9_-]{1,29}$'
ORDER BY handle;
```

If any rows are returned, the operators decide new names together with the members. Avoid reserved names and other members' names, change `handle` and `handle_key` together to values that follow the new rule, run the check above again, then run the migration. Synthetic development and test accounts are subject to the same constraint. Do not drop the CHECK constraint because the migration failed.

### Mention destinations (0058, 0059)

`0058_member_mention_bindings` adds a permanent public ID for each member, a revision number for the original text and a table that stores mention destinations. `0059_translation_mention_revisions` adds the revision number a translation was made from. After the SQL migrations, `pnpm db:migrate` (the same step at container startup) resolves the mentions in existing originals and edit history once, using the user names at that time, and stores them. Resolution uses current usernames; it cannot reconstruct who owned a name when historical text was written. On a database with actual member content, inspect username changes and ambiguous historical mentions, back up, and resolve uncertainties with the operators before running the backfill. Synthetic fixtures need no historical attribution review. Do not run only the SQL by hand and consider it done.

Mentions that could not be resolved are also stored, as unresolved. From then on, rendering, rendering translations and restoring from soft deletion use the stored destinations. Running the backfill again does not change stored bindings. The rendering version (`RENDER_VERSION` in `app/lib/markdown.server.ts`) changes, so the usual re-rendering of the cache also turns existing mentions into links to public IDs.

## 9. Logs and privacy

Check that access logs do not store invitation or authentication URLs, query strings, Referer, cookies or Authorization. The supplied Caddy does not enable access logs. Do not treat the commented examples in the configuration as tested redaction; if you enable logs, check the actual output.

Treat app logs, mail, glossary exports and translation comparison output as private material as well. Decide how long they are kept and who may read them, and redact secrets in reports made while investigating.

## 10. Security headers

Over HTTPS, check the CSP, the browser storage policies and the cache control of the authentication pages. Do not strip the app's headers at an outer proxy. Check passkey registration and post approval on the real screens.

## 11. Staging with fake engines

Only in an isolated environment without member data may you use `TRANSLATION_PRIMARY=fake`, `EMBEDDING_ENGINE=fake` and `TOMOLA_ALLOW_FAKE_ENGINES=1`. Never use them where members are invited. Keep test mail capture separate from production SMTP. Do not switch production `NODE_ENV` to development to skip the checks.

## 12. Acceptance checks at the deployment

Check public DNS, issuing and renewing certificates, delivery through real SMTP, passkeys in real browsers, process restarts, the translation worker, and restoring a backup into another database. A successful `/healthz` alone does not complete acceptance.

To run the real PostgreSQL tests, set `TEST_DATABASE_URL` to a dedicated disposable database and account. Do not run `pnpm test:pg` or `pnpm test:e2e:prod` against a member database.

## 13. Opening a language and checking the interface translations

The startup checks and `pnpm langs:open` require `missing` and `stale` to be 0 for every enabled language. For languages other than Japanese and English, the number of unchecked strings, excluding the operator-only screens and their header links, must also be 0. The moderator screens, mistranslation reports and glossary editing are in scope of the check. `pnpm i18n:translate --check --require-verified` shows both the total number of unchecked strings and the number excluding operator-only ones, and uses the latter as the condition. Untranslated strings are not allowed even on operator-only screens.

1. In a working tree, translate the untranslated entries with `pnpm i18n:translate --lang <tag>` and update stale translations with `pnpm i18n:translate --stale --lang <tag>`. With a model key set, this calls the external API. An untranslated entry is simply absent from the file and is shown in English, but it may not remain in a language you enable.
2. Someone who reads the language checks the public interface strings. Record keys that were corrected against the source with `--stamp`, and record only the checked keys with `pnpm i18n:translate --verify --lang <tag> --by "<reviewer>" <key>...`. Use `--all` only when every key of the language has been checked. Also get permission to store the name in the review record.
3. Pass `pnpm i18n:translate --check --require-verified --lang <tag>`, and review the changes to `messages/` against the publication policy. Also check `needs_review` on the rows of the initial glossary that translate into that language, and update only the approved entries.
4. Add the tag to `ENABLED_LANGS`, rebuild the image, and check the configuration checks and startup.
5. Check the counts and the cost estimate with `docker compose exec app pnpm langs:open <tag> --dry-run`, and after approval run it without `--dry-run`. The worker translates within the budget.

To open a language as a preview before a native speaker has checked it, prepare the translations, pass `pnpm i18n:translate --check --strict --lang <tag>`, then add the tag to both `ENABLED_LANGS` and `PREVIEW_LANGS` and rebuild the image. `PREVIEW_LANGS` is comma-separated and treats case, spaces and duplicates the same way as `ENABLED_LANGS`. Empty means no preview. Naming a language that is not enabled, `ja`, `en` or an unknown tag stops startup in every environment. In production, startup also stops for a language with missing, stale or untranslated strings. It also stops for a language that has unchecked public strings and is not in the preview.

In a preview language, the shared footer, including before login, says that the interface is an unchecked machine translation. If unreviewed glossary entries remain, open it with `langs:open --allow-unreviewed-glossary`. When the public strings have been checked, pass `--check --require-verified --lang <tag>`, remove the tag from `PREVIEW_LANGS` and restart; the notice disappears. Checking the glossary and each static page translation is separate from interface review.

Fake engines are not used in an ordinary deployment with members. To close a language, remove it from `ENABLED_LANGS` and `PREVIEW_LANGS` and restart. Translations are not deleted, but members who mainly use that language need to be told.

## 14. Adding to the home screen (PWA)

In a real browser over HTTPS, check adding to the home screen and the offline page. Check that Cache Storage holds nothing but static assets and the offline page: no member pages, API results or credentials. Check the same after updating the service worker.

On Android, other apps can share a title, a URL and selected text to tomola added to the home screen, and they are passed to the form at `/t/new`. The member checks the content and posts it. The server does not fetch the shared external URL. Before offering this integration, check on a real Android device that shared content arrives in the body and survives a login in between. It cannot be used as a share target on iOS.

The offline page is stored when the service worker is installed. Each build embeds a fresh cache identity in the worker; activation removes the previous build's asset cache and installs the current offline page. If you change its text or `ENABLED_LANGS`, deploy a new build and check that existing devices update to the new page. An installed app is bound to the original host name; after a host name change it has to be installed again. On iOS, the home-screen app and Safari may have different login states, so check the 6-digit email code, the confirmation link and passkey login on real devices. The email may be read on another device, but the code is entered in the browser that asked for it. The code and the link expire in 15 minutes, and using either one makes both unusable. A login lasts 30 days and is extended at most once a day while in use. Members can log out other devices in settings; API tokens and AI connections are revoked on their own screens.

## 15. Checks before admitting members

The operators check the content before inviting members. Passing the server's startup checks does not mean the following checks are done.

- Replace the parts of the principles page marked as being prepared with the real pages and contacts. Configure the site-specific text and destinations through the Operator settings section of this guide. The shared principles have 17 editions in `app/content/principles/`, with Japanese as the original; update those files when changing the common principles. The tests read headings and structure from the source, so text changes need no edits to expected values. The startup checks do not check this replacement.
- Have people check each translation of the principles page. Only for a language that has been checked against the original, delete the line `Unverified machine translation` under the title of that language's file (one place). `app/lib/principles.server.ts` derives the status of a translation from this line: Japanese is `"original"`, a translation with the line is `"unverified"`, and one without it is `"human_checked"`. The marker is compared ignoring surrounding spaces, line endings and case, and loading rejects the Japanese original if it has the marker. Check that the opening line of the text, the link to the original, `principles_lang_original` and `principles_langs_label` in the language list, `/principles.md?lang=<tag>`, `/llms.txt` and `/api/openapi.json` agree on the status. The principles can be read in all 17 languages regardless of `ENABLED_LANGS`. This is separate from the conditions for opening a language for the interface and for posts; the additional eight tags are available for the principles, why and name pages, not the interface or posts. Check each page's original link and translation-review marker independently.
- Compare the configured terms, privacy notice, participation conditions, AI-use policy and displayed consent text with actual data handling. Check the remaining `disclosure_no_lookup` statement against the operator's policy; do not infer research consent from a translation key or a test-site notice.
- Set `SOURCE_URL` to where the corresponding source is published. Settle the scope and the rights of publication so that the source corresponding to the running version can be reached.

## 16. Observation and exports

Check the operator metrics together with their numerators, denominators, the number of people and the observation period. Do not report a group that was not observed as zero. Do not put exported member data or operational records in the public repository; handle them after confirming the purpose and who may see them.


### Static copy of public content

Run `docker compose exec app pnpm site:export --out /tmp/site-export --lang ja,en`, then copy the whole directory with `docker compose cp app:/tmp/site-export ./site-export`. Alternatively, mount a dedicated writable output volume and pass a subdirectory beneath its mount point with `--out`. The container user `node` needs write permission on the directory's parent to replace the export. Omit `--lang` to use all enabled languages; requested languages are limited to those enabled. Posts in a closed source language remain readable on those pages through a translation or the original-text fallback. Open `index.html` as a file; no server is needed.

The export is a copy of public content, with HTML and Markdown for topics and replies, the principles and why pages, a manifest, and local styles and math fonts. It includes no member-only records. Hidden and deleted topics are omitted; hidden and deleted replies retain only a placeholder. The database is read in a read-only snapshot; the command neither migrates nor calls model APIs. Stop the development server before exporting from its PGlite directory.

Use a dedicated output directory: a successful run replaces its entire content. An existing nonempty directory is accepted only when its `manifest.json` identifies this exporter with `format: "tomola-public-site"` and `version: 1`; unrelated directories are refused. A failed generation leaves the previous copy intact. A deleted post disappears on the next export. If you publish an export, replace the entire published directory every time, including removing old files; do not accumulate earlier exports at the public location. This command does not upload or publish anything.

### Village preparation

Deploy with `VILLAGES` empty first. The migration creates the village tables and nullable references without assigning existing data. Open villages during a maintenance window with writes stopped: block browser, API and MCP write traffic, and pause background workers and other writers. Keep writes stopped through preparation and the enabled app's successful health check. A topic posted after preparation while the setting is still empty has no village and will stop the enabled app at startup.

Run `docker compose exec app pnpm villages:prepare` to inspect the plan, then `docker compose exec app pnpm villages:prepare --write`. Both commands run independently of `VILLAGES`; dry run is the default. Repeated preparation preserves existing placements and defaults, including an empty default after a member leaves all villages.

Preparation does not fill or reset `profiles.defaultVillageId`; its reported `defaults` count is zero. A missing default resolves to the member's personal village during ordinary publication, separately from this preparation step.

Preparation creates missing villages for `ENABLED_LANGS`, enrolls previously unprepared members in their main-language village and assigns unplaced topics by their recorded posting area (`author_area`), falling back to the original language when that area is empty or `other`. Enrollment records its first completion time; subsequent preparation leaves those members' choices alone. Members registered while villages are closed have no such mark and are enrolled on the next preparation. Unmatched topics and conflicting slugs are listed and stop the entire write operation. An operator must resolve them before continuing. Back up data before any manual changes.

The same command names the language of the name and description of villages made before they had one (their author's main language; the language of the text itself for a language village that an operator described) and queues the missing translations of those texts into the other enabled languages. The dry run counts both. The translations are made by the worker like those of posts, with the same engine and monthly budget, and a village's original is shown until its translation is ready. Run the command again after changing `ENABLED_LANGS` or after failed translations to queue what is missing (`pnpm langs:open` does it for the language it opens).

After successful preparation, set `VILLAGES=1` in the deployment environment and recreate the app container. After migrations, startup checks that every enabled language has a village and every topic has a placement. Restore write traffic and workers only after `/healthz` succeeds. To add an enabled language while villages are open, use the same maintenance window and prepare its village with the new environment before restarting.

If the readiness check stops startup, the app may repeatedly restart and `docker compose exec` will be unavailable. Keep writes stopped, empty `VILLAGES` in the deployment environment, and run `docker compose up -d --force-recreate app`. The closed app skips the village readiness check and starts normally. Once healthy, run the dry run and `--write` commands above, then set `VILLAGES=1` and recreate the app again. Confirm `/healthz` before restoring writes. Clearing the setting does not remove villages, memberships or placements.

### Village reports

With `VILLAGES=1`, members can report a public village from its page, including language villages and ended villages. Operators handle these reports in `/mod`; language moderators cannot handle village reports. Language village descriptions are edited as operator configuration, resolving open reports without moderation. Village reports can also be dismissed. For member-created villages, operators can correct the name, description and slug, or end the village. Operators who do not own a member-created village must use this recorded moderation path, including when there is no report. Operators cannot handle or review cases for villages they own. Forms reject changes when the management history has changed since they were opened. Old slugs replaced by moderation are held for 90 days, during which only an appeal restoring the same village can reclaim them.

All current owners receive moderation notifications. One current owner may appeal each instance of moderation once; the appellant can still read that appeal and its result after leaving ownership. An independent operator who neither owns the village, carried out the moderation nor reported the village can review it. Overturning a correction restores earlier details only if no later edit or slug collision prevents it. Overturning an ending reopens the same village without restoring cancelled invitations or changed defaults.

Clearing `VILLAGES` closes new village reports and the direct moderation entry; existing reports, moderation, appeals, public records and moderation notifications remain available. Public moderation records show the current public village name and address, without notes, prior details or reporter identities. Dismissed reports show no village name or address. While villages are disabled, existing records show village names as plain text. Daily cleanup removes handled report snapshots after 180 days, retaining the reports and moderation records.

### Village chat delivery

Village chat is disabled by default. Do not enable it until the notification, translation-consent and moderation features are ready. Chat access requires current village membership, including in public villages. Ending a village leaves its chat readable and allows authors to delete their own messages.

While chat is enabled, members can also list and delete their own undeleted messages at `/settings/chat`, reached from the advanced settings near the data download. This includes messages from villages they have left or that have ended, and messages hidden by moderation. Suspended members can delete their own messages. Bulk deletion requires confirmation and removes at most 500 messages per request; repeat if messages remain. Deletion clears the body and mention bindings and advances the shared change sequence for each message. Existing report evidence is unaffected.

The current member export is version 16. Version 16 added `profile.color_scheme`, the saved appearance (`light`, `dark`, or null to match the device). `push_subscriptions` contains only registration counts, coarse browser/OS labels and registration dates, without endpoints or keys. Version 14 added `saved_topics`, which contains only the member's private saved topic IDs and save times, without topic content or other members' data. Version 13 added `village_icons`, an array of the current uploaded icons of villages the member owns, including shared ownership. Each item contains `village` (the slug), `mime` (`image/webp`) and rewritten image bytes in `base64`. Historical village icons retained as evidence are excluded. Version 12 added residence, adult confirmation and participation/stance consent records to the profile. Version 11 added `profile.avatar`: `uploaded` records whether the member currently uses an uploaded image; when true, `mime` is `image/webp` and `base64` contains the rewritten image bytes. With an automatic avatar, `uploaded` is false and both `mime` and `base64` are null. Historical avatar images retained as review evidence are not included. Version 10 added the optional `display_name` and `display_name_latin` profile fields. Version 9 added `village_follows` (the public villages the member follows; nothing else about them) to version 8's `chat_messages`. Version 8 added `chat_messages`. It contains only the member's undeleted messages, including hidden ones. A private former village is represented by the generic former-village label instead of its name or slug. With chat disabled the array is empty and no chat tables are read; the other export fields remain unchanged.

Same-site public topic URLs in chat receive up to three topic cards per message, with the available title or translation, reply count and a link to the public reply form. Hidden, deleted and nonpublic topics are excluded. Cards read saved translations in one page-wide database query; they do not fetch external sites or request translations. No chat content or chat backlink is added to public topic pages.

Chat events carry only a village change sequence, never message content. Responses use `Cache-Control: private, no-store, no-transform` to bypass compression and `X-Accel-Buffering: no` to discourage proxy buffering. A comment is sent every 20 seconds. Before enabling chat, verify prompt delivery through every proxy and tunnel in the deployment; direct-server tests do not establish that result. Disconnected clients fetch changes every 15 seconds.

Delivery currently uses a registry in one server process. Multiple web processes require a shared signal mechanism, such as PostgreSQL LISTEN/NOTIFY, before deployment. Connections close after 10 minutes and authenticate again when reopened. Leaving, removal, village closure and server shutdown close the applicable connections.

### Missing translation reconciliation

`TRANSLATION_BACKFILL_ENABLED=1` enables daily reconciliation from the cleanup job. It defaults off. Each run queues at most 100 public post/language targets that lack a current translation and have no translation job. Only enabled languages qualify. A stopped monthly budget prevents enqueueing. Enabling this can cause provider calls for existing posts; use fake engines in isolated tests. Prompt-version changes alone never trigger retranslation.

### Translating post bodies when they are read

`TRANSLATION_EAGER_SCOPE` selects `readers` (the default) or `all`. Titles
continue to be translated into every enabled language when published.
`TRANSLATION_EAGER_MIN_READERS` is a positive integer, default `1`. With
`readers`, a body is translated immediately into languages read by at least
that many active members, plus the languages of the village's members and
followers and notification recipients. The existing display-language preference
rule applies. Suspended and deleted members are excluded from the audience count.
Other enabled languages are requested only by a browser reading the topic page.

Browser requests include at most 101 posts (one topic and 100 replies). Requests
are limited to 300 post/language pairs per member per hour, or 120 per trusted
client IP range per hour for visitors. These are fixed hourly windows; requests
around a boundary may consume two windows. Repeated requests count toward the
limit but do not duplicate unfinished jobs. Missing client addresses share a
restricted fallback allowance. Polling stops after two minutes, including time
spent in a background tab. The monthly translation budget still applies.
Markdown, API, MCP, export and server-rendered reads never request work or record
displays. The browser records only the first display timestamp of a translation,
without a reader identity or view count. These timestamps do not affect ranking.

Run `pnpm exec tsx scripts/translation-read-stats.ts` in the operator environment
to print counts, displayed counts and percentages by original language, target
language and post kind. The report counts body translations (primary and human),
not provisional titles or secondary quality checks. PostgreSQL may remain
running; stop the development server before opening the same PGlite directory.

## Existing figures

With `FIGURE_TRANSLATION=1`, the pre-migration startup check also verifies the six bundled font files (Regular and Bold for Noto Sans, Noto Sans Thai and Noto Sans CJK) and their coverage metadata without opening the database or calling a provider. Run it in a disposable container before replacing the running app:

```sh
docker compose run --rm --no-deps --entrypoint ./node_modules/.bin/tsx app scripts/check-startup.ts
```

Jobs verify font availability before translating labels. Failed probes and missing files are retryable; verified coverage is cached, while failed probes are not. If rendering must retry after translation, the existing paid-response checkpoint avoids another provider call. A verified unsupported code point, permanent reading refusal or permanent label-translation failure keeps the original and is not retried after an edit or backfill.

After fixing missing fonts, requeue jobs that exhausted their retries while the feature was enabled with `pnpm figures:backfill --enqueue`.

Preview existing published figures without provider calls or queue writes:

```sh
pnpm figures:backfill
```

The preview counts distinct authored images with a readable published reference, excluding avatars, village icons, withdrawn images, hidden/deleted topics and replies, and unaddressable places. Existing readings and variants are reused. Unknown readings use a documented label-count assumption and the most expensive possible source language among supported tags. Prices come from the configured primary and reading models, including price overrides; the thinking allowance is an estimate, not observed usage or a spending cap. Pending jobs are included in the outstanding-work estimate.

After enabling the feature and reviewing the preview, explicitly queue missing work:

```sh
FIGURE_TRANSLATION=1 pnpm figures:backfill --enqueue
```

This command only queues work. Workers apply the ordinary public budget, visibility checks and deletion fences. Repeating it deduplicates pending jobs and reuses finished results. It opens an existing migrated database without applying migrations or loading an environment file. Supply database/model settings through the process environment. Stop a development PGlite server before using its data directory; PostgreSQL may remain running.


## Device notifications (Web Push)

Device notifications are disabled by default. With `WEB_PUSH` unset or empty,
settings show no device-notification section and the push endpoints return 404.
Only `WEB_PUSH=1` enables them; any other nonempty value fails startup. Existing
email preferences and home-screen installation guidance are independent.

Before enabling, apply the database migrations, add the delivery services and
metadata to the operator's privacy notice, and test representative iPhone,
Android and desktop clients and a screen reader with the operator's approval.
Automated fake-provider checks do not verify OS permission prompts or delivery.

Generate one fixed VAPID key pair per environment in a private operator terminal:

```sh
pnpm push:keys
```

Keep `VAPID_PRIVATE_KEY` in the server secret configuration. Distribute only
`VAPID_PUBLIC_KEY` to browsers. Set `VAPID_SUBJECT` to a public operator contact
(`mailto:contact@example.org` or a public HTTPS contact page); do not put a
private address there. All three settings are required and validated when
`WEB_PUSH=1`. Never regenerate keys on every start or include their output in
logs, tickets or reports. Set `WEB_PUSH=1` and restart only after the approved
device checks. To pause future sends and hide the settings, clear `WEB_PUSH` and
restart. Notifications already accepted by a delivery service may still appear
until their TTL expires (at most two hours).

Registrations identify browser storage areas, independently of login sessions.
The last session used to authorize each registration must still exist and be
unexpired at send time. Opening tomola while signed in renews that authorization.
A session copied during home-screen installation can authorize two independent
registrations. Signing out that shared session pauses sends to both until a new
sign-in and reconciliation, even though only the current browser registration is
explicitly stopped. Switching accounts stops the previous registration and
requires an explicit new opt-in. Stopping locally also attempts browser
unsubscription and closes displayed notifications. Remote stopping prevents
future sends; it cannot remotely erase notifications already displayed.

Only Apple (`web.push.apple.com`), Google (`fcm.googleapis.com`), Mozilla
(`updates.push.services.mozilla.com`) and Microsoft (`notify.windows.com` and
one regional subdomain) HTTPS endpoints are supported. DNS results must all be
public IP addresses; requests connect to a validated address with the provider's
TLS hostname and never follow redirects or use an environment proxy.
Subscriptions are capped at ten active registrations per member. Delivery
coalesces notices about the same topic or chat village within one minute,
sends at most 60 groups per member per hour, and expires after two hours.
Provider acceptance is recorded separately from attempts; it does not prove
that the OS displayed a notification. Tests are limited to three per ten minutes.

Notifications show only a generic notice type in the recipient's interface
language. No post body, title, author name or handle is included. Providers
receive delivery identifiers, encrypted payloads, sender, timestamps, frequency
and message sizes. Settings include the user-facing explanation. Subscription
endpoints and keys must stay out of application logs and member exports.

For key rotation, first pause with `WEB_PUSH` empty and restart. Generate and
install a new pair, retain the public operator contact, and restart with the
feature enabled only after checks. Old-key registrations remain active but receive
no deliveries until each browser explicitly reconnects from Settings. New notices
do not queue deliveries for these registrations. A queued delivery with a mismatched
key ends with a generic operator error, without stopping the registration or
changing its generation. Restoring the old key restores delivery for new notices.
A send starts when its short database reservation commits. Stopping prevents
new reservations; an already reserved send may finish, even if stopped during
HTTPS. Its result cannot reactivate or update a stopped or replaced registration.
Stopping a registration immediately erases its endpoint and subscription keys;
coarse device labels and registration dates remain until account deletion. Finished
delivery records expire after 30 days through the daily retention cleanup.
Do not rewrite stored browser keys or move endpoints between accounts. A 404 or
410 stops only the affected registration. Rate limits honor `Retry-After`;
transient failures retry within the delivery expiry. Authentication, malformed
message and redirect failures leave registrations intact and fail the queue job
with a generic operator error. After correcting the provider configuration,
new notices can be delivered again. Failed notices remain available in the
in-app notification list; do not bulk reset delivery records. No queued notice
is guaranteed to be sent exactly once across a crash after provider acceptance.
