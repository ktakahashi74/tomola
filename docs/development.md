# Development and verification

Verify the behavior affected by a change. Use documentation checks for documentation, focused unit and browser checks for affected behavior, and full verification for integration and release candidates. Record the tested revision, scope, settings and result with the change so another developer can assess the evidence.

## Everyday entry points

| Target | Command | Scope |
| --- | --- | --- |
| Existing requirements of the deployment docs and the public README | `pnpm check:docs` | Documents and the files shipped with Docker. Does not start a database |
| Pure functions and documents | `pnpm test:fast` | Lint and the test files listed as not needing a database, and the safety conditions of the check runner |
| A specific behavior | `pnpm check:focused tests/entries.test.ts` | The given files. No database setup if every file is on the no-database list |
| A specific real PostgreSQL path | `pnpm check:focused --pg tests/entries.test.ts` | The given files on a disposable PostgreSQL database. Needs `TEST_DATABASE_URL` |
| Unit tests that use a database | `pnpm test:db` | Everything except the verified no-database list. Uses the usual PGlite setup and teardown |

`check:focused` takes explicit unit files, or `--changed` to select from changes against the merge base with `origin/main` (override with `--base=<ref>`). With neither, it stops. Changed unit, development-browser and production-browser specs select their complete files; production selections build their own output. Source imports select dependent unit files and tests that read sources or import routes dynamically. Product changes retain every browser scenario in both reading modes. Configuration, fixtures, assets and unknown inputs conservatively select the full scope. An empty change set runs no tests. Review the selection with `--dry-run`; selection is an aid to choosing scope, not a substitute for the integration checks. Add `pnpm typecheck` for app changes that need type checking, and the browser paths you need for effects on screens or shared code. Do not add checks outside the scope.

Without JavaScript, the site guarantees only that text can be read and that links can be followed. New interactions do not need a JavaScript-free path or dedicated tests for one. Test the interaction of components such as menus in a browser with JavaScript enabled.

`check:docs` is an entry point that separates the document checks, which used to be mixed into files with a database. It does not guarantee that the documents are correct in general; check links and new procedures according to what you changed. `tests/fast-files.ts` is kept as the list of files confirmed individually with `vitest.fast.config.ts` not to need a database. The fast configuration rejects database creation, including indirect calls through the route harness. Tests that open a database only in a child process also stay outside this list. Detecting changes by imports alone misses documents read with fs and run-time dependencies, so choose the tests from the content of the change.

Install the dependencies first, and whenever they change, with `pnpm install --frozen-lockfile`. When you check something in another worktree that uses existing dependencies, take care that pnpm's pre-run check does not start an automatic install. Only when you have confirmed that the dependencies match the lockfile may you add `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` to that verification command. Do not make a setting that silently accepts mismatched dependencies in normal development. See [pnpm's pre-run check](https://pnpm.io/settings/build#verifydepsbeforerun).

Contribution and DCO sign-off requirements are in [CONTRIBUTING.md](../CONTRIBUTING.md). Site-specific terms, contacts and participation conditions belong to [Operator settings](deploy.md#operator-settings), separately from the software's development workflow.

## Dependency updates

Use pnpm 12.16.1, as pinned in `package.json` and the Dockerfile's `PNPM_VERSION`. Keep these versions aligned when updating pnpm.

Pin direct authentication dependencies (`better-auth`, `@better-auth/*` and `@simplewebauthn/*`) to exact versions and keep up with supported patch releases. Check the passkey plugin's dependency ranges before changing the SimpleWebAuthn major version. Prefer `^` for other dependencies, retaining existing explicit compatibility pins. The two Inlang plugins are also pinned exactly so their build-time code is covered by the lockfile's integrity checks.

Review `pnpm outdated` and `pnpm audit --prod` when updating dependencies. Update the selected packages, commit the lockfile, and verify the affected authentication, signing and OAuth paths. Reinstall with `pnpm install --frozen-lockfile` and regenerate the third-party notices after production dependencies change.

Paraglide reads its plugins from `node_modules` through `project.inlang/settings.json`; paths are relative to the repository root. Once dependencies are installed, `pnpm typecheck` and `pnpm build` work offline. The Docker build stage disables networking for compilation. A fresh dependency installation still needs registry access or a complete local package store.

Class-name merging uses `cn/engine` with tables generated from the application sources. Vite and Vitest use the same `cn/build` options in `scripts/cn-build.ts`; the `cn/vite` plugin writes the ignored `app/lib/cn-tables.generated.mjs` before serving or building. Theme registration stays disabled to preserve the original merger's treatment of custom animation classes. Import `cn` from `~/lib/utils`, so the full default tables do not enter page scripts. Keep complete class names in the scanned sources when choosing them dynamically; extend the content inputs or a generated safelist when classes come from another source. `tests/cn.test.ts` compares source-class combinations and overrides with the original merger.

## Interface strings

Write new strings in `messages/en.json` and `messages/ja.json`. Write nothing in the other languages; untranslated entries are shown in English. When you change the English of an existing string, run `pnpm i18n:translate --drop-stale`, which calls no API, to delete the stale translations and the fingerprints of their sources. `--lang <tag>` narrows the target. A translation that reads the same as the English stays as long as its fingerprint matches.

`pnpm i18n:translate --check` shows the number of untranslated entries and checks the structure of the existing translations and their correspondence to the source. `--check --strict`, used before opening a language, also treats untranslated entries as problems. Missing entries in English or Japanese fail even the normal check.

## Integration and release candidates

`pnpm check:integration` runs, in order, the runner checks, lint and disclosure baselines, the type check, every PGlite unit test, the build, the page JavaScript budgets, and four concurrent browser groups: three private groups and one public-reading group. All ordinary browser groups reuse that invocation's build output through `node server.ts`; they never rebuild per group. Each group uses one worker and an independent source copy, build output, generated files, dependency cache, PGlite data and seeded sessions. Files are assigned in one place, `scripts/browser-groups.ts`, using measured serial file times to balance the private groups; new files fall back to their test declarations. A file's serial scenarios stay together. `E2E_GROUPS=3` through `6` selects the total group count, including the single public-reading group.

Ordinary build-backed tests use `NODE_ENV=test`, all nine languages by default, fake translation and embeddings, local fake SMTP and a local TLS proxy. Their purpose is application behavior with the ordinary fixtures. Service workers are blocked in ordinary scenarios so module interception and isolated fixtures remain effective; worker registration, caching and offline behavior stay in the production suite. Production startup, language-release gates, CSP and the production proxy contract remain covered separately by `e2e-prod/` with its existing production settings.

Focused browser checks and direct `pnpm test:e2e e2e/example.spec.ts` commands still use the development server by default, without waiting for a build. Set `E2E_SERVER=build` explicitly for a direct browser run against an existing build. Check step settings and `browserServer` in `.data/checks/latest.json` identify the server choice; browser attempt records also carry `server`. Each development server defaults to four Rolldown runtime workers and four Rayon workers, with two glibc allocation arenas on Linux. Explicit `ROLLDOWN_WORKER_THREADS`, `RAYON_NUM_THREADS` and `MALLOC_ARENA_MAX` values take precedence.

On Linux hosts with `run-validation` on `PATH`, the check commands automatically enter the host's shared validation memory budget before running any steps. Existing nested job limits are retained. Other hosts run normally. `TOMOLA_VALIDATION_RUNNER` can name an explicit executable, and `TOMOLA_VALIDATION_RUNNER=0` disables the optional host launcher. Dry runs never start it. Direct commands such as `pnpm test:e2e` can be wrapped explicitly as `run-validation --label tomola -- pnpm test:e2e`.

Set `E2E_PORT` to the first group's port. Following groups add 10,000 each: for example, 5311, 15311, 25311 and 35311 for the default four groups. Each build server also reserves its public port plus 1 for internal HTTP and plus 2 for fake SMTP. Reserve all those ports. The first port must be at least 1024 and leave room through `E2E_PORT + (E2E_GROUPS - 1) * 10000 + 2 <= 65535`. Set `E2E_SERIAL=1` to run the complete private suite and then public reading sequentially in the original workspace, reusing the build and only the first port and its two local service ports.

Browser output is saved separately under `.data/checks/browser-logs` and printed one group at a time. Each group's exit code and duration appear in `.data/checks/latest.json`; a failing group does not stop the other browser groups. Traces, server logs and other output are retained under `.data/checks/browser-artifacts`. `E2E_KEEP=1` also retains each group's database and server log there; the temporary source copies are always removed. Development-server copies prepare their locale modules before startup, keeping generated-file reloads out of the tests. Build-server copies use the existing generated output. Concurrent servers have up to four minutes for cold startup; sequential runs keep the two-minute limit. Ordinary scenarios have zero retries. Only scenarios registered in `e2e/quarantine.ts` get one retry; each entry records its cause and repair deadline. Every attempt, including recovered failures, is retained in browser timing records and the check summary. The final output and the `quarantineRecovered` counts for each group, step and run show how many quarantined cases passed on the second attempt after failing the first. Persistent quarantined failures still fail the run.

The quarantine registry is currently empty. Keep ordinary scenarios at zero retries; register an exception only with a concrete cause and repair deadline, and remove it after the cause is fixed and the case is stable.

Right after the build, `node scripts/check-bundle-size.mjs` checks the gzip total of the JavaScript each screen loads (including the shared parts and parent routes) against its configured reading or writing budget. The script defines those limits in one place. `scripts/check-baselines/bundle.json` stores gzip bytes from the reviewed main build; a page also fails when it grows by at least 5 KiB, defined once as `PAGE_GZIP_GROWTH_LIMIT`. A new page needs a reviewed baseline entry. After a reviewed main build, `node scripts/check-bundle-size.mjs --write-baseline` refreshes that record explicitly; normal checks never write it. When integrating a change that affects page JavaScript into main, run that command against the reviewed build and commit the updated baseline together with the change, so the next comparison starts from the new main. It is part of `check:integration` and `check:release`, and exceeding the limit stops the remaining checks.

The production-configuration run follows the ordinary build-backed groups in release mode. `pnpm check:release` includes the database-using unit files on PostgreSQL with `vitest.db.config.ts`, one production-build browser run on PostgreSQL, and the migration metadata check. Without a dedicated `TEST_DATABASE_URL` it stops before running. The PostgreSQL unit stage also fails if any PostgreSQL-tagged test is skipped or its skip-count report is missing. Integration may skip those tests and records their number. Do not point it at a production or everyday development database. The test account needs permission to create disposable databases. The build runs only once, and the production browser tests reuse the output of the same successful run. Do not skip it because of an earlier successful build. A local `pnpm test:e2e:prod` run can still use PGlite when `E2E_PROD_PG` is unset.

The existing `pnpm test`, `pnpm test:pg` and individual Playwright commands remain. Do not impose the full verification on every change; use it where integration needs it. Generate the schema when the schema changes, not every time you check a result.

With `--dry-run`, only the steps are shown; the tests are not run and no result is recorded. Showing steps that include real PostgreSQL also needs the dedicated URL to be checked first.

```sh
pnpm check:focused --dry-run tests/email.test.ts
pnpm check:integration --dry-run
```

When a host validation launcher supplies `TOMOLA_VALIDATE_MODE=parallel`, release runs its two full unit backends concurrently. With serial mode or without host admission metadata, it runs them sequentially. Browser grouping still follows `E2E_SERIAL` independently.

## When results may be reused

The check commands update `.data/checks/latest.json` and append a start row (`event: "started"`) and a final row to `.data/checks/history.jsonl`, linked by a unique `runId`. A start without its final row identifies an interrupted run. Older rows without an ID are read as finished runs. The final record includes the starting commit SHA, whether the checkout has uncommitted changes, `standardMode` (the canonical mode name only when every planned step matches, otherwise null), `postgresSkipped` (only real PostgreSQL stages), `postgresSkippedInPglite` (intentional PostgreSQL-only skips outside that mode), the scope, the hash of the inputs, the settings, the exit code and duration of each step, and the steps that did not run.

`validation` records the validation launcher's `mode` (`parallel` or `serial`), `availableGiB` and shared-slice working set `sliceGiB`, supplied nonnegative integer lock and memory waits in milliseconds, and explicit serial flags. Unit stages that run concurrently retain separate commands, settings, exit codes, durations, skip counts and failed-test evidence in `groups`; their output is saved under `.data/checks/unit-logs`. Both finish before the next step starts, and either failure stops the pipeline. Unit concurrency does not change `browserExecution`. `browserExecution` is `parallel`, `serial`, or `none` when the plan has no browser stage. For `--changed`, `selection` records the requested comparison ref, resolved merge base, changed-file count (and paths up to 500), chosen unit and browser files, and fallback reasons. Dry runs show the same selection diagnostics without executing checks. Each unit stage's `unit` records failed test identities and collection failures, capped at 200 each with full counts, plus per-file status, skipped counts and pending counts. Skipped titles and failure message bodies are omitted. Browser attempts include their owning spec file and declaration line; the line is `null` when a helper declared the test in another file.

Real API keys, mail and ordinary database connections are not passed to child processes, and secrets are not recorded. Diagnostic titles redact email addresses and local paths. If an environment setting changes what a check verifies, state that condition separately.

A run stops at the failed step and does not repeat the same check automatically. If code, settings or documents under test change during a run, it is `stale` with exit code 2. The fingerprint starts from `git ls-files` plus new nonignored source files, including `public/` and `docker-entrypoint.sh`. Generated Paraglide output and project caches are excluded; tracked documentation remains an input. A `running`, `failed` or `stale` record of an interrupted run is never treated as the final success.

Developers and reviewers can reuse a record when its inputs, conditions and exit status match the proposed change. Reference that record in the review instead of rerunning unchanged checks. Add related checks for new changes, unresolved failures or missing evidence. Review behavior, permission boundaries and explicit requirements separately from style preferences and future proposals.

Read one or more history files with the standalone tool; it does not change them. Repeating the same path reads it only once. Malformed rows are skipped and counted.

```sh
node scripts/check-history.mjs <history.jsonl> [<other-history.jsonl> ...]
node scripts/check-history.mjs <history.jsonl> --mode=release --since=2026-11-01T00:00:00+09:00 --json
node scripts/check-history.mjs --help
```

A date-only `--since` value means midnight UTC. Prefer a timestamp with an explicit timezone, as above. The tool reports results by mode, first-attempt and quarantine-inclusive pass rates, rates excluding interrupted runs, and separate rates for repeated input fingerprints. The original rates include all runs; the additional rates exclude interrupted runs but retain stale runs. Unstable candidates share a test identity and input fingerprint with both failure and pass observations, including quarantined tests that fail and pass on retry within one run. These are candidates for investigation, not proof of a cause. For count-only unit reports, files with any skipped or pending tests do not establish that an individual failed title later passed. Timing distributions use only runs whose planned stages all finished, exclude stale runs, and separate parallel, serial and no-browser runs. They show medians and nearest-rank p90 values for stages, groups and browser files, plus recorded waits.

## Deployment checks and concurrent development

Before admitting members or changing a main journey, identify the deployment features and clients being tested. Check the journey from an invitation through sign-in, posting, replying and reading a translation. For an isolated screen change, prioritize that interaction. Verify actual client connections and devices separately; automated test counts do not establish usability or deployment readiness. Record changes to that scope for the people responsible for the deployment.

Use separate working trees and generated outputs for concurrent changes. Do not run browser tests against outputs being rewritten by type generation or another build. When reusing results from another checkout, confirm that its inputs match the release candidate. Review and publish changes through the repository's contribution process.

## Browser tests

Ordinary browser tests use private and public-reading configurations. Run the private suite with `pnpm test:e2e` and the public-reading suite with `pnpm exec playwright test -c playwright.public.config.ts`. The selection inventory is `e2e/reading-modes.ts`: public-only cases run on the public server, and shared media-delivery and deleted-parent checks run in both modes. Every run seeds all fixtures; no fixture switches are required. A disabled-language writing case runs in the production suite, whose enabled languages are Japanese and English.

Use a dedicated member, invitation and owned topics for each independent scenario. Find owned rows by identity across pagination; do not assume a global topic count, first row or fixed page. Read interface text from the message catalogs, and take evidence screenshots only when `E2E_EVIDENCE_DIR` is set.

Non-authentication setup uses API-created members and sessions from `e2e/member-fixtures.ts`. `useMember` applies their Playwright storage state and retains explicit locale and editor storage. Signup, confirmation and login scenarios still use the screens and fake mail. Independent scenarios own separate accounts; serial steps within one connected journey keep that journey's account.

## Third-party notices

`pnpm notices:generate` regenerates the production dependency appendix in
`THIRD_PARTY_NOTICES.md` from the project lock document and installed package
metadata and bundled license texts, retaining the manual introductions, including the vendored longread.css notice.
`pnpm notices:check` and `pnpm check:docs` fail when it drifts. Run after a
frozen-lockfile install on the target image platform. Platform-specific
optional packages that are not shipped are listed separately. Keep the
supplemental upstream texts and font provenance in `scripts/licenses/` current
when updating their versions. The image carries `LICENSE` and the notices.
This inventory does not replace review of source-offer obligations when
redistributing native libraries or the base operating-system image.


## Tool baselines and timings

`test:fast`, integration and release run ESLint with the two React Hooks rules and the recommended JSX accessibility rules. Parsing uses no type services. `scripts/check-baselines/lint.json` allows existing findings by file and rule; increases fail. The local route-action rule checks the AST for a writer or role gate, with documented exceptions in `scripts/lint/writer-exceptions.mjs`. Runtime member and suspension tests remain the authority for permissions.

Docs, integration and release also scan tracked and new nonignored text files for private references. Local user paths, private host forms, internal numbered references and handoff paths are counted per file and pattern. The scanner excludes the baseline records themselves, binary files and secret environment files; it does not follow symlinks. Existing references remain recorded in `scripts/check-baselines/disclosure.json`. This pattern check does not establish that content is suitable for publication. Both finding baselines can be refreshed explicitly with `node scripts/check-lint.mjs --update-baseline` and `node scripts/check-disclosure.mjs --update-baseline`; review the changes, rather than refreshing a baseline to bypass a failure.

Browser check attempts are recorded as `browser-results-*.json` under `.data/checks/`. Run `node scripts/update-browser-weights.mjs` to preview measured file weights, then add `--write` to update `scripts/browser-weights.json`. Only successful complete private-group runs and successful first attempts contribute; public-reading runs, focused runs and retried files do not lower the private weights. The median of each file's measured totals reduces the influence of a single busy run. Unmeasured files retain their previous value or the declaration-count fallback. Normal checks never update the weights.

Vitest defaults to four workers in every configuration, including real PostgreSQL. The full unit stages in integration and release explicitly use six workers per backend; focused and no-database checks keep their existing limits. The production setup additionally starts and stops `node server.ts` without a fixture preload and checks that a Markdown page renders before starting the instrumented browser server. To exercise populated upgrades separately, run `pnpm check:focused --pg tests/migrate-seeded.test.ts` with a dedicated `TEST_DATABASE_URL`. It creates a disposable historical schema at migration `0073`, inserts synthetic posts, a reply, a draft, a translation, queued jobs and an image, then checks data preservation, backfills and idempotence through the current migration set. Release also includes it in the PostgreSQL unit stage; no production database or real participant data is used.

### Translation evaluation

`eval/translation/cases.yaml` is a versioned set of public excerpts and invented examples. Each case supplies stable checklist IDs, severity weight, source attribution and target languages. Change the set version when changing its contents. Runs also retain a content hash so changed checklists are not compared accidentally.

A case may include a `title` and `respondsTo`, the ID of an earlier case covering the same language pairs. Titled cases translate the body before the title, using the production body-context budget. Response cases reuse the earlier case's generated title and paired body passages, together with explicit author spellings for the target language. The invented essay and response in E39 and E40 check terminology across titles, bodies and differing viewpoints. No participant posts are included.

Start with `pnpm eval:translate --estimate`. This command reads the set and prints estimated translation/judge calls, a range allowing for one structure retry per translation, and approximate costs using the configured price table. It neither opens the database nor constructs API clients. Token lengths, glossary allowance and thinking tokens are assumptions; this is not a hard spending limit.

The translator follows `TRANSLATION_PRIMARY`, `TRANSLATION_GEMINI_MODEL` / `TRANSLATION_CLAUDE_MODEL`, and `GEMINI_TRANSLATION_THINKING`. Translation uses the current production prompt, a frozen snapshot of the active database glossary, and the production structure checks with one retry. Evaluation does not run the secondary/divergence pipeline or change existing member translations.

The checklist judge has independent settings:

- `EVAL_JUDGE_PROVIDER`: `gemini`, `claude`, or `fake`. Defaults to `fake` for a fake translator, otherwise `gemini`.
- `EVAL_JUDGE_MODEL`: defaults to `gemini-3.6-flash`, `claude-haiku-4-5`, or `fake-eval-judge` for the selected provider.
- `EVAL_JUDGE_THINKING`: `off` (default), `low`, or `default`; applies to Gemini. Other providers record `not-applicable`.

Only source text, translated text, semantic checklist entries and (for response cases) the original case's terminology context are sent to the judge. Mentions, exact URLs, code, math, Markdown shape and numeric values use deterministic checks. Fake judgments exercise the workflow and do not assess meaning.

The command deliberately does not load `.env`. Supply the database and engine settings explicitly. In a deployed environment, run inside the application container to use its configured settings, for example `docker compose exec app pnpm eval:translate --estimate`. When running from a local shell, unset any unrelated `GEMINI_API_KEY` first and explicitly set the translation provider, model, thinking setting and database; review the printed configuration before approving calls. A fake run is free:

```sh
TRANSLATION_PRIMARY=fake EVAL_JUDGE_PROVIDER=fake pnpm eval:translate
```

Real calls require explicit approval after reviewing the estimate, followed by `pnpm eval:translate --allow-paid`. Apply database migrations before running. Each run retains translations, checklist results, configuration, glossary contents/version, usage and calculated cost. Failed runs retain their completed work and have no score in `/admin/metrics`. A terminated process can leave a run marked running; it is never treated as completed.

The operator metrics page shows the latest 30 runs, language-pair and category scores, severe errors, and differences from the preceding completed run with the same set hash and real/fake mode. Same-provider judging and fake engines are labelled. Differences carry a note when translator, prompt, judge or glossary settings differ from the preceding run.

Usage signals start when the metrics migration is applied; historical generation counts or correction outcomes are not reconstructed. Count each primary post/reply field and target language once per source revision, excluding outputs with copy or hidden-output flags. Refining a provisional title and redoing flagged output do not increment the count; a saved report retry counts once per field. Chat counts committed translations. Reports are divided by generated translations, so repeated reports can produce a rate above 100%. Only saved corrections and changed automatic retries count toward correction rates and median days; dismissals, source changes and hiding are not corrections. Deleted reports leave report totals, while identifier-free generation counters remain.

API/MCP drafts retain a baseline until publication. The last tool-supplied title/body are compared with published text. Only numeric character counts and change spans remain after publication, and the operator receives aggregates by API/MCP, never member-level values. The span between the first and last changed character is an upper bound on edits, not an exact edit distance. Existing drafts without a baseline are excluded. Hidden/deleted published posts are excluded from draft aggregates. Original-text opening is not tracked.
