# tomola

tomola is multilingual forum software for long-form posts and discussion. People write in their own language; AI translates posts into the reader's chosen language while keeping the original available. Questions, positions and reasons help readers explore different views.

The software is under development. Before inviting members, complete the operational and content checks in the [deployment guide](docs/deploy.md).

## Features

- Email sign-in by a six-digit code or confirmation link, and passkeys. Codes and links work only in the requesting browser, expire after 15 minutes, and share a single use. Members can enable passkey signatures for their posts; signing is disabled by default.
- Original posts and replies, uploaded images, side-by-side translations, a shared glossary, and translation reports. Optional figure translation reads and translates image labels while keeping the original image available.
- Optional villages (`VILLAGES=1`): personal, shared and language villages, with opt-in village chat (`VILLAGE_CHAT=1`), translated messages, reporting and moderation.
- Optional public reading of posts and lists. Readers can switch reading languages independently of the interface language.
- Questions, positions and reasons, Insightful reactions, follows, search, notifications, a private saved list, and public site and village RSS feeds when public reading is enabled.
- Member pages and mentions whose saved destinations survive username changes.
- A bookmarklet and Android web-app sharing for preparing a post from a page title, URL, or selected text. Members review the content before posting.
- Markdown and API access, plus authenticated MCP reading and draft creation. Members confirm publication in the browser; an MCP or API credential cannot publish a draft.
- A web app with an offline notice. Its service worker caches static assets and the offline page, rather than member content.

The current version requires an invitation to create an account; it has no public self-registration option. Public reading is a separate deployment setting and does not enable registration. Members can export their data and delete their accounts, choosing whether to retain their posts or hide them for scheduled erasure. See the [account deletion](docs/runbooks/account-deletion.md) and [retention](docs/runbooks/retention.md) procedures for limits and preservation conditions.

Supported interface and posting language tags are `ja`, `en`, `fr`, `de`, `zh-Hans`, `zh-Hant`, `ko`, `th`, and `vi`. Operators choose which to enable. The principles, why and name pages also have editions in `es`, `pt`, `ru`, `ar`, `hi`, `id`, `bn` and `ur`, for seventeen languages in total; these additional languages are not available for the interface or posts. Static page editions remain readable independently of enabled interface languages. Japanese is the original; other editions retain an `Unverified machine translation` marker until checked against it. Language support and machine translation do not establish human review. See the [language deployment checks](docs/deploy.md#13-opening-a-language-and-checking-the-interface-translations).

The [public architecture](docs/architecture.en.md) and [decision rationale](docs/design-decisions.en.md) explain the design, its history, and its limits. Japanese reference versions: [architecture](docs/architecture.ja.md), [decision rationale](docs/design-decisions.ja.md).

## Local development

Use Node.js 26 or later and the pnpm version pinned in `package.json`. Node.js 26 no longer bundles Corepack; install it with `npm install -g corepack` and run `corepack enable`.

```sh
pnpm install --frozen-lockfile
umask 077
cp .env.example .env
```

Keep API keys and SMTP settings empty for local development. A deterministic fake translation and embedding engine permits development without external model calls:

```sh
GEMINI_API_KEY= ANTHROPIC_API_KEY= SMTP_URL= MAIL_FROM= \
  TRANSLATION_PRIMARY=fake TRANSLATION_SECONDARY=none \
  DIVERGENCE_JUDGE=none EMBEDDING_ENGINE=fake pnpm dev
```

Open `http://localhost:5173`, matching `BETTER_AUTH_URL`. The development server uses embedded PostgreSQL through PGlite, with data in `.data/pglite`. PGlite permits one process to open that directory at a time.

To create a local invitation, stop the development server, run the command below, then restart it. The address is an example; replace it with your local test address.

```sh
pnpm invite tester@example.org
```

Without SMTP in development, sign-in email is printed to the server console. Keep the requesting browser open: enter the six-digit code there, or open the emailed link in that browser and confirm. The email may be read on another device. Invitation URLs, sign-in links, and codes are credentials: keep console output private.

Sessions last 30 days and refresh after a day of continued use. Settings can log out all other browser sessions; API tokens and connected AI clients are revoked on their own screens. Members without a passkey can register one from the optional banner, or dismiss it for 30 days in that browser.

## Checks

Choose checks for the change. Routine documentation and pure-function checks do not need a database:

```sh
pnpm check:docs
pnpm test:fast
pnpm check:focused tests/email.test.ts
```

See [development and verification](docs/development.md) for focused, integration and release checks. PostgreSQL integration and production browser tests need their own isolated database and configuration. Never point test commands at a database containing member data.

Without JavaScript, reading post bodies and following links are guaranteed. New interactive controls may require JavaScript; a separate no-JavaScript path and test are not required for each new operation.

## Deployment

The supplied Compose configuration uses PostgreSQL with pgvector, an app container, and Caddy for HTTPS. See the [deployment guide](docs/deploy.md) for configuration, migrations, backups, and checks before admitting members.

Each site's operator name, terms, privacy notice, contact details and participation conditions are deployment-specific settings. Configure and review them for your own site using the deployment guide's [Operator settings](docs/deploy.md#operator-settings) section. Public reading, enabled languages and test-site notices are independent settings.

Keep `.env` on the deployment host or configure an equivalent secret store. Compose reads it into the runtime environment; it is excluded from Git and the Docker build context. Publish `.env.example` only with empty secrets and generic examples. Never publish database dumps, captured mail, invitation lists, or agent logs.

Production requires working HTTPS and SMTP, a strong authentication secret, and real translation and embedding engines. Match the model provider's current data handling terms to the site's disclosure before using member posts with an external provider. Fake engines are for member-free development and staging.

## License

Copyright (c) 2026 The tomola Authors

tomola is licensed under [AGPL-3.0-or-later](LICENSE). See the license for its terms. `SOURCE_URL` configures the site's link to the corresponding source.

Third-party code and its license notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution process, checks and Developer Certificate of Origin sign-off.

## Security

Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.
