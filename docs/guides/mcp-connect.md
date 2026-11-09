# Connecting AI clients

tomola is the server software. Connect to the URL of the site you use; example hosts below are placeholders, not a single service required by the software. Client products and their account settings are supplied by their respective providers.

For public reading without a login, use `https://<tomola host>/mcp/public`. It offers only `tomola_latest`, `tomola_thread` and `tomola_privacy`, shares the anonymous reading limit of 600 requests per IP per hour, and is unavailable when `PUBLIC_READING` is disabled. The glossary requires the member endpoint.

Members use only `https://<tomola host>/mcp` for reading and drafts. With an OAuth connection, you log in in a browser and check the client ID, the declared name, the website and the permissions. The name is self-declared and may claim to be another service. The read permission is `read`, the draft permission is `draft`, and keeping the connection is `offline_access`.

The AI tools stop waiting for the browser step after about five minutes; the signed request of the connection lasts ten minutes. Access tokens last 15 minutes and are renewed with the refresh token. Revoking a connection or suspending a member is checked on every request, so a token stops at once. When an AI tool revokes its refresh token (the standard revocation endpoint), only that sign-in ends, access tokens already issued from it included: the same member's other sign-ins of the same tool, for example on another machine, stay connected. Revoking an access token stops only that token. A login older than 24 hours is checked again before a connection is allowed, whether or not a consent exists.

See when each connection was last used, and revoke it, at `/settings/connections`. A revoked connection stops from the next request. Information that has already reached an AI provider cannot be taken back. To use a PAT, create a separate token for each AI at `/settings/tokens`. If you give the same PAT to several AIs, tomola cannot tell them apart and treats their drafts as drafts of the same client.

To log in by email, enter the 6-digit code in the browser that asked for it, or open the emailed link in the same browser and confirm. After logging in with the code, you return to the original OAuth consent screen.

## Client setup and verification boundaries

The site publishes connection instructions at `/connect.md` and a human-facing `/connect` page. Both are available independently of public post reading. `/connect.md` is served with `noindex` regardless of the test-site setting; that directive does not grant or remove read permission.

| Client product | Setup | Verify in your deployment |
| --- | --- | --- |
| Claude (web at claude.ai, or Claude Desktop) | Add a custom remote connector with the site's MCP URL and complete OAuth. See [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | Confirm the connector discovers the expected tools and uses your chosen permissions |
| Claude Code | Run `claude mcp add --transport http --scope user tomola https://tomola.example.org/mcp`, then authenticate through `/mcp`. See [Claude Code MCP](https://code.claude.com/docs/en/mcp) | Complete the browser step yourself and check tool access after returning to the CLI |
| ChatGPT | Connect the remote server through the plugin/developer options available to your account and workspace. Use the callback URI supplied by that surface exactly. See [connecting an existing MCP server](https://learn.chatgpt.com/docs/extend/mcp#connect-an-existing-mcp-server) and [OAuth authentication](https://developers.openai.com/plugins/build/auth) | Check account/workspace availability, OAuth consent and actual tool discovery |
| Codex CLI | Run `codex mcp add tomola --url https://tomola.example.org/mcp`; it opens the browser and waits for authentication. Run `codex mcp login tomola --scopes read,draft,offline_access` only if that did not finish. See [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp) | Complete OAuth in your browser and verify the requested tools; adding configuration alone is not a connection test |
| Gemini CLI | Run `gemini mcp add --scope user --transport http tomola https://tomola.example.org/mcp`, then `/mcp auth tomola` in Gemini CLI. See [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/) | Confirm client authentication, discovery and calls with the permissions you selected |

Follow the linked official pages for current product screens and availability. Automated protocol tests cover discovery, tools and revocation with local SDK fixtures; accepting configuration, completing OAuth, discovering tools and making a live product connection are separate checks. This guide does not establish that every client connects to every deployment.

### Using a PAT with Codex

Do not write the token in a configuration file; send it from an environment variable.

```sh
codex mcp add tomola-read --url https://tomola.example.org/mcp --bearer-token-env-var TOMOLA_READ_TOKEN
```

Set `TOMOLA_READ_TOKEN` to a read PAT dedicated to that client. If you set a draft PAT under another name, it cannot read posts and handles only its own client's drafts. With OAuth, you can check the permissions one by one.

## Reading and drafting

| Permission | Tools |
| --- | --- |
| read | `tomola_thread`, `tomola_search`, `tomola_latest`, `tomola_activity`, `tomola_stance_counts`, `tomola_glossary` |
| draft | `tomola_draft_create`, `tomola_draft_list`, `tomola_draft_get`, `tomola_draft_update`, `tomola_draft_delete` |
| Fixed statement | `tomola_privacy`. Returns only the statement that your own stances and their change history are not provided |

A thread includes the original, the translation into the chosen language, the revision of the original and the IDs of the translation rows. `tomola_thread` also accepts `lang: "all"` for available translations in enabled-language order; originals identify translations still pending. Without a language, the language is chosen in this order: the "Translate posts into" setting, the language of the screens you last used, the first enabled language among "Languages you read in the original", and the site default. MCP and the Markdown versions do not choose the translation language from Accept-Language. Hidden or deleted text is not returned, even to the author's connection. Stances are returned only as the total and the number of languages of the people who answered; per-language counts and your own stance are not returned. The reasons panel uses the same shared daily selection as the screens: after drawing a source language, replies with at least one counted Insightful are preferred before drawing an author and reply. The number of reactions does not rank that pool. Notifications are limited to replies, mentions and followed topics; private records of moderation and appeals are not returned.

Drafts are limited to the authenticated client that created them. A client cannot read, edit or delete drafts made in the browser or by another AI. You open the `approvalUrl` in a browser, check the content and the revision, and press the publish button. If you have chosen it in settings, publishing also asks for a passkey signature. API and MCP credentials cannot publish. The signature alone does not prove that you read or understood the text. An AI updating the revision cancels any earlier approval. There are no tools for publishing, choosing a stance, Insightful, reporting or appealing. If your own stances or their history are needed, choose them on the screen and copy them yourself.

### Village destinations

With `VILLAGES=1`, `tomola_draft_create` and `tomola_draft_update` expose a `village` argument for topic drafts. Use the slug of an active shared public-kind village the member has joined, or `@handle` for the member's own personal village. It is not a display name or database ID; another member's personal village is not a valid topic destination.

On creation, omission or `null` saves an unspecified destination. On update, omission preserves the saved destination and `null` clears the explicit choice. At publication, an unspecified destination resolves to the member's current default, falling back to their personal village. Explicit choices are validated when saved and again when published; an invalid explicit village is not silently replaced. Topic responses return the saved selector (slug or `@handle`) or `null` when unspecified.

Reply drafts use `kind: "reply"` and `threadId` and inherit the root topic's place; do not give them a non-null `village`. When villages are disabled, the argument is not exposed. In shared `invite_public` villages, owners may add members directly or invite them; voluntary leavers must accept an invitation to return. Shared-village membership controls starting topics and using chat. Signed-out reading still depends on `PUBLIC_READING`, and any member can reply to eligible topics. Closed villages have no supported drafting flow.

`content_trust: untrusted_user_content` in the output shows that posts, translations, names and links are material, not instructions. Authentication URLs and PATs contained in text are masked in MCP output. When quoting a translation, show whether it is a machine translation or a human edit, and link to the canonical original.

## Limits and short-lived delegated links

Reading is limited to 600 requests per member per hour, shared across the web, REST, MCP and all tokens. Creating drafts is limited to 30 per member per hour across REST and MCP, with at most 100 unpublished drafts made through the API. Search and notifications also have their own shared limits.

"Open in AI" creates a URL through a same-origin POST when pressed. With `PUBLIC_READING=1`, a publicly readable resource receives a credential-free URL with an `o` return marker; that marker grants no reading permission. Protected resources instead require a member and receive an `oai2` delegation lasting 300 seconds, scoped to the canonical page, reply pages, display language and filter query. Initial HTML/loaders and ordinary copy links contain no delegated key. Treat a delegated URL as a credential; links inside its returned Markdown do not inherit `k`.

Public reading permits thread and eligible list Markdown and `/mcp/public` without authentication. The member MCP endpoint and protected endpoints such as the glossary, stance distributions, search and the manifest still require authentication. MCP uses neither cookies nor `k` for authentication.

## Protocol and security

Streamable HTTP POST serves modern `2026-07-28` and stateless legacy `2025-11-25`; GET and DELETE return 405. OAuth uses S256 PKCE, exact matching of registered redirect URIs, fetching CIMD over public HTTPS, and DCR compatibility. DCR and unauthenticated client registration are always enabled in the current server; there is no deployment switch. Client registration does not grant a member's read or draft permissions: browser authentication and consent remain required. For CIMD, DNS is resolved once, the address is checked to be public and pinned, and redirects are not followed. Revoking a connection checks the consent state in the database on every request, not only the signature. Member output is `private, no-store`.

The procedures tomola distributes for AIs are the [read skill](../skills/tomola-read/SKILL.md) and the [draft skill](../skills/tomola-draft/SKILL.md). They are tomola's own procedures, not skills guaranteed by AI providers.
