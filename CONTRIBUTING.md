# Contributing to tomola

Discuss substantial behavior or architecture changes in an issue before implementing them. For a focused bug fix or documentation correction, a pull request can explain the problem and proposed result directly.

Do not report security vulnerabilities in public issues or pull requests; follow [SECURITY.md](SECURITY.md).

1. Create a branch from the current `main` in your fork or authorized checkout.
2. Keep the change focused. Use invented fixtures and generic example addresses; never include credentials, member data, invitation or sign-in links, database dumps, captured email or private logs.
3. Update relevant documentation. English is the common language for code comments and test names. Japanese is the reference for the bilingual design documents; keep the English version synchronized when meaning changes.
4. Run checks appropriate to the change and describe their scope and results.
5. Sign off every commit and open a pull request against `main`. Explain the problem, resulting behavior and any material limits of verification. Respond to review on the same branch.

## License and Developer Certificate of Origin

Contributions to tomola are submitted under **AGPL-3.0-or-later**, as set out in [LICENSE](LICENSE), unless a file has its own compatible third-party license. Preserve existing copyright and license notices; record the source and license of imported material in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

"The tomola Authors" in the copyright notice means everyone who has contributed to tomola; each contributor keeps the copyright in their own contributions.

Read the full [Developer Certificate of Origin 1.1](https://developercertificate.org/) before contributing. By adding a `Signed-off-by` trailer you certify the contribution's origin and your right to submit it under the applicable license. DCO sign-off is not a copyright assignment: contributors retain their copyrights.

Add your sign-off with:

```sh
git commit -s
```

Git uses the name and email address configured for that commit. Use an identity you are entitled to use and willing to publish; a GitHub-provided no-reply address can protect your personal mailbox. Sign-offs and other submitted commit metadata become part of the public contribution record described by the DCO. Sign-off is a textual certification, separate from cryptographic commit signing.

For your own latest unsigned commit, `git commit --amend --no-edit -s` adds the trailer. Do not certify someone else's work on their behalf. Maintainers should preserve contributor attribution and sign-offs when merging or squashing; ask the contributor to supply a missing certification before merging. This guide does not claim that a hosted DCO check is already configured.

## Development and checks

Use Node.js 26 or later and the pnpm version pinned in `package.json`. Start with the [local development instructions](README.md#local-development), [AGENTS.md](AGENTS.md) and [development guide](docs/development.md).

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm check:docs
```

For code changes, choose affected tests rather than treating the documentation check as behavioral verification:

```sh
pnpm test:fast
pnpm check:focused tests/email.test.ts
```

Use `pnpm check:focused --pg tests/<target>.test.ts` for affected real PostgreSQL paths, with a dedicated `TEST_DATABASE_URL` whose account can create disposable databases. Never point checks at a production or member database. Keep authentication, signing, private-data and concurrency regression coverage. Integration and release candidates use the broader checks documented in [docs/development.md](docs/development.md); they are not mandatory for every small change.

Use fake model engines and local mail fixtures unless a task explicitly requires an approved real-service check. Keep secrets out of pull request descriptions and test output as well as source files.
