# Developing tomola

Keep changes within the requested scope. Read the relevant code and current documentation before editing; historical plans are context, not implementation requirements. Explain changes to public visibility, data use, authentication, permissions or feature scope in the proposed change.

## Choose verification for the change

| Change | Verification |
| --- | --- |
| Documentation | Check changed links, procedures and exclusion rules; run `pnpm check:docs` |
| Comments | Confirm executable code, strings and directive comments are unchanged; check migration hashes only when affected |
| Pure functions | Run the affected tests; use `pnpm test:fast` for a broader no-database check |
| Application behavior | Run affected unit tests, necessary browser paths and type checks; `pnpm check:focused tests/<target>.test.ts` requires explicit files |
| Database, locks, authentication, signatures or permissions | Keep boundary and regression coverage; use a dedicated database with `pnpm check:focused --pg tests/<target>.test.ts` for real PostgreSQL paths |
| Integration or deployment candidates | Verify the fixed candidate with `pnpm check:integration` or `pnpm check:release` as appropriate |

Use regression tests when they can detect new behavior or a bug. Documentation, comments and mechanical moves do not require newly failing tests. Broaden verification when shared behavior, integration or unresolved failures justify it. Do not repeat unchanged successful checks without a reason.

Preserve regression coverage for authentication, signing, private information and database concurrency. Import-based change detection cannot see every filesystem document read, runtime import or database effect; choose scope from the affected behavior too.

Never test with production databases, real API keys, real email recipients or member data. Real PostgreSQL tests need an isolated test account permitted to create disposable databases. Use fake translation, embedding and mail fixtures for local verification.

## Review and evidence

Review the changed behavior and necessary adjacent code. Fix defects, regressions, data loss, security issues and violations of explicit requirements. Separate style preferences and future improvements from required repairs.

Check commands record results in `.data/checks/latest.json`. Record scope, settings, exit status and unverified conditions, not just passing counts. Reuse another check only when its code, configuration and final status match. Interrupted, failed or stale runs are not successful final evidence; rerun only the affected checks after resolving the cause.

## Concurrent work and browser checks

Use separate working trees and generated outputs for concurrent changes. Do not regenerate types or builds while another task is checking the same output in a browser. Stop only processes started for your task, using the job's own PID.

For a screen change, check the affected interaction first. For a new deployment or a changed main journey, check invitation, sign-in, posting, replying and reading a translation. Confirm real clients and devices separately; automated test counts do not establish usability or deployment readiness.

## Public repository hygiene

Write comments and test names in English. Keep the Japanese reference design and corresponding English documents synchronized when meaning changes. Explain design reasons in words; omit private decision numbers, handoff references, local paths and internal host names.

Keep secrets, database dumps, captured mail, invitation lists, real member records and agent logs out of code, fixtures, commits and pull requests. Retain third-party copyright notices and provenance. Keep temporary files outside the repository and remove the files created for the task when finished.

See [docs/development.md](docs/development.md) for commands and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and sign-off requirements.
