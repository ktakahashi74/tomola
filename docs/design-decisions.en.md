# tomola Design Decisions and Rationale

[日本語](design-decisions.ja.md) · [Architecture](architecture.en.md)

Implementation checked: 2026-11-08 (static checks of the features and settings covered by this revision). Japanese is the reference text; corresponding English sections retain the same scope.

This document preserves the reasoning developers need when changing the design. Each section explains the choice, recorded reasons, changes from earlier options, and relevant alternatives or limits. Where reasons were not recorded, that gap is explicit rather than filled with a plausible retrospective explanation.

Design principles, current designs, site operating policies, and future directions are distinguished. Current refers to code at the stated date, not completion of deployment, real-device checks or readiness for members. New implementation properties and constraints are explained from code; unexplained numeric choices are not assigned speculative reasons. Consult the architecture for the overall specification and code for validation, types and database constraints.

## 1 Support encounters between different perspectives

**Design principle.** The primary purpose is to bring different assumptions and readings into contact across languages so that participants can revise their own views. Developing and accumulating thoughts in one's own language also matters. The software does not restrict subjects or make access to English the sole purpose. Producing consensus or convergence on one conclusion is not a platform objective.

**Rationale.** Gathering people who read the same information in the same way would provide little of the intended value of encounters between different priors. This is a design hypothesis, not evidence that crossing languages necessarily creates intellectual diversity.

## 2 Separate core principles from revisable features

**Design principle.** The core covers authoritative originals, explainable common orderings chosen by readers, human responsibility, non-authoritative platform AI, minority reasons and objections, and exit with checks on concentrated power. Presentation, notifications and usability can change while respecting that core.

**Rationale.** The community must first attract participants and remain viable, then pursue its ideals. Treating every initial feature as an immutable principle would prevent learning from member experience.

## 3 Do not treat language as a proxy for beliefs

**Design principle.** Reading is open across languages. Counting units, ranking signals, exposure allocation and governance boundaries are considered separately. Language groups are not displayed as schools of thought. The design excludes inferred multiple memberships, membership-weighted votes, classification by members' AI, and using machine-discovered opinion clusters for display or ranking.

**Rationale and change.** The relationship between language and priors is a hypothesis to examine, not an attribute the design can establish in advance. The initial prohibition on integrating evaluations was narrowed to single-score ranking and exposure. It does not prohibit displaying totals. Boundary rules need reasons, appeal routes and review dates. In October 2026 the principle was revised. The blanket prohibition on aggregating across languages was dropped, because a prohibition defined by language groups conflicted with this section's policy of not fixing language as the unit of thought. Reaction totals may be used as one of the orderings. One commitment is unchanged: the platform produces no conclusion and no overall score for people. Section 18 describes current orderings.

## 4 Distinguish human contributions from AI statements

**Design principle and future direction.** A person and their AI form the unit of participation. Writing with and without AI is treated equally. A person checks and takes responsibility for posts published in their name. Platform AI assists translation and search; it does not decide agendas, evaluation criteria, rules or consensus statements.

**Rationale and change.** The boundary concerns who bears consequences, rather than capability. An initial blanket prohibition on automated AI posts evolved into a distinction between human-confirmed contributions and clearly marked AI statements. AI proxy replies remain a future consideration, not an implemented replacement for drafts and human confirmation. Independent AI participants are also a future question.

## 5 Keep originals authoritative and translate full text

**Current design.** Originals are authoritative; full translations are versioned derivatives. Translation states, access to originals, a glossary, error reports, human corrections and optional cross-engine checks work together. Readers can always inspect the original regardless of their language preferences.

**Rationale and limits.** Reading assistance must not replace the original or silently change the author's claim. Translation must preserve uncertainty and hesitation rather than turn them into certainty. A requirement in a prompt is distinct from demonstrated translation quality, which needs human review under actual usage conditions.

## 6 Do not provide an author translation category

**Current design.** There is no special category of author-guaranteed translation. Translations belong to the platform's translation process, with reports, retranslations and human corrections.

**Rationale and rejected option.** Author translations were dropped because authors would otherwise be asked to endorse languages they cannot read. They could also change a question's proposition through its translation after the original was frozen by a position. Original freezing and translation correction therefore use separate authority and records.

## 7 Bound automatic retries after translation reports

**Current design.** Members can report a translation with one action, and readers can see that it has been reported. When an automatic retranslation model is configured, the first report permits one retry for the same source revision and language. Further problems, or an unconfigured retry model, go to human review.

**Record limits.** The recorded choice uses a stronger model for the initial retry and moderators afterwards. A comparison explaining why one retry was chosen over another number is not recorded. Retranslation does not establish that the error was resolved or reviewed by a native speaker.

## 8 Develop glossary candidates through visible discussion

**Current design.** The glossary holds translation candidates and notes; proposals can start in any language. Changes are discussed as forum posts, with acceptance by the operator or target-language moderator. History and appeals remain available. Initial vocabulary emphasizes common domain terms and ordinary words whose meanings depend on context.

**Rationale and alternatives.** Terms peculiar to one work could impose an operator's framework through translations of other people's posts, so they are excluded from the initial vocabulary. English is not the sole reference language. GitHub pull requests were rejected because they require another account and tend to center discussion on English.

## 9 Distinguish supported languages from enabled languages

**Current design.** The interface and posts support nine language tags; choices, translation, email and browser-language selection use only the languages enabled by the site. Languages open when contributors and review are ready, with translations of existing posts. Simplified and Traditional Chinese are separate tags. The principles, why and name pages have seventeen editions, readable independently of enabled interface languages. Members keep one saved display language for menus, buttons and default translations. Registration aligns it with the selected main language. A device cookie takes precedence, followed by the saved preference, the page language subject to its reading-only mark, browser preferences and the site default. Explicit choices update both the cookie and the account; ordinary visits and login preserve existing preferences. Guests keep their cookie, page-language and browser negotiation. Temporary reading-language choices belong to article headers, while list links still apply and carry explicit language queries. Original-reading preferences and the main language retain their separate roles; a translation-language override is available under advanced settings.

**Rationale and limits.** Script-based names accommodate vocabulary differences without assigning participants a regional or political identity. Interface strings use English as their translation source; machine generation and native-speaker review are separate. A supported tag or page edition does not establish that every site has enabled every language or completed review.

## 10 Separate primary translation from cross-engine checking

**Current design.** Gemini and Claude are selectable primary engines, with configurable alternative and judging engines. Multilingual translation and embeddings through one API were the recorded reasons for initially choosing Gemini. Translation and usage records retain engine and model, distinguishing a different model from a different provider.

**Rationale and limits.** Translation assists reading while preserving claims and tone; comparisons and divergence judgments provide material for quality review. Alternative and judging engines default off. Missing credentials or engines do not count as divergence measurement; agreement between models does not prove correctness. Titles are translated into every enabled language, while bodies follow reader languages and browser requests; translating all bodies eagerly is also configurable. See [architecture](architecture.en.md#6-translation-and-glossary) for settings and the boundary that machine reads do not request work.

## 11 Make member questions a form of post

**Current design and change.** Operators do not set a common agenda. Members can ask for positions through a flag on a post, rather than a separate post type. Questions, position choices and attributed reasons are current features.

**Rationale and alternatives.** Rejecting a central common question means that operators do not choose the agenda; it does not remove units around which members can exchange opinions. Importing external formats remains separate from this minimal mechanism and is deferred.

## 12 Separate unnamed positions from attributed reasons

**Current design.** Positions are agree, disagree or neither, and are always unnamed. Members who want to state a position under their name write an attributed, marked reply. Its classification is not checked against their unnamed selection. Framing objections are not forced into the three choices.

**Change and scope.** Unnamed-by-default became always unnamed, with attributed posts carrying responsibility. Confidence levels, a separate mechanism for citing existing posts as reasons, and permission settings for featuring reasons are outside the minimal version. Section 28 explains the privacy boundary and limits.

## 13 Freeze a question once another member takes a position

**Current design.** A question's title and body freeze when the first member other than its author takes a position. Additions go in replies. Moderator typo corrections are recorded actions, notified to the author and subject to appeal.

**Rationale and rejected option.** The proposition to which positions attach must not change afterwards. An initial title-only freeze allowed body edits with history and notification; this was replaced by freezing both. Section 6 addresses the corresponding translation loophole.

## 14 Separate displayed counts from language-specific ranking

**Current design.** Insightful reactions and positions show totals and the number of contributing languages, including a single language. Per-language breakdowns, language-composition displays and color-coding people by language are absent. Position distributions count respondents; they are not the community's conclusion. Deletion and exclusion affect aggregates.

**Rationale and change.** Differences in thinking are shown through positions and reasons rather than language categories. Earlier small-group suppression, hourly updates and minimum-change rules were dropped as safeguards for a language breakdown when that breakdown was removed. Using totals remains one explainable ordering chosen by readers, not a platform conclusion or an overall score for people. Timing and small-group inference risks remain.

## 15 Use the same selection of reasons for every reader

**Current design.** Each position has up to three equal slots. Among replies by authors not yet shown, selection randomly draws a source language not yet shown for that position. Within that pool it prefers replies with at least one counted Insightful, if any, then randomly draws an author before randomly choosing one of that author's replies. After all languages have appeared, the same presence-based preference applies. Reaction-count ranking and AI assessment are absent. Displayed slot order does not depend on the reader's position. The first question/UTC-day selection is saved and shared by screens and MCP. New replies do not trigger another draw that day; deletion, hiding, exclusion or changed marks remove items immediately, with replacement the next day.

**Rationale and limits.** Equal slots preserve minority reasons. Drawing a language and then an author reduces the advantage of writing many replies. Earlier preferences for languages outside the reader's own and per-page redraws are absent. One and many Insightful reactions supply the same signal, but their presence biases the pool. Scarce-language authors can gain more exposure, writing in a less represented language can be rewarded, and resistance to organized reactions remains limited.

## 16 Preserve objections to questions, actions and rules

**Design and operating policy.** Framing-objection replies and alternative questions have a permanent panel. Moderation appeals go to a reviewer not involved in the action. Principles explain ordering and allocation rules with their reasons.

**Rationale and limits.** Minority objections should not disappear under reaction counts, and decision-makers should not be the sole appeal authority. Objections to rules, principles and glossary choices are separate from implemented moderation appeals. Dedicated routes, actual contacts, staffing and review schedules are determined by each site.

## 17 Use reactions to indicate gaining a new perspective

**Current design.** Insightful is the single reaction, combining earlier agreement and changed-my-mind reactions. After reacting, a small link offers position reconsideration. It does not require a change or reorder reasons according to the member's position.

**Record limits.** The reaction means gaining a new perspective. It is not an agreement rate or evidence of a position change. Combining reactions is a simplification decision, not a validated measure of every underlying mental response.

## 18 Combine a stream of posts with depth in threads

**Current design.** Home lists posts across languages in creation order, with activity and Insightful order available. Activity uses the latest reply activity; Insightful uses counted reactions to the root post, then creation time and ID. Reply votes are not added to root votes. Question/titled-post filters, source-language, following and village lists are available. Personal unnamed positions and behavior histories do not determine rank.

**Implementation and limits.** Untitled remarks and titled articles share a stream, with threads supporting continuation. Creation order reads source rows; activity/reaction order uses rebuildable `topic_listing_stats`. Related discussions come from links in original posts, not AI recommendations. Period-based reaction ordering, personalized recommendations, reposts and trends are outside this implementation.

## 19 Start discovery and return features with limited scope

**Design and staging.** Mentions, topic/question follows, notifications, a private saved list and home-screen installation support return visits. Saved topics and save times are private records, never public reactions or recommendation signals. Site and village RSS feeds include only topics readable without login and require `PUBLIC_READING=1`. Taking a position does not automatically follow a topic. Person follows, reposts and trends are not added. The email default policy batches replies and mentions over five minutes and other events daily; this is distinct from a site's delivery settings.

**Device notifications.** Web Push is disabled by default. Only with `WEB_PUSH=1` may members opt in per browser. Replies, response posts and mentions are usually sent after about one minute, without post bodies, titles or author names. Registrations are separate from sessions; delivery and opening recheck recipients and permissions. User disclosures and representative devices must be checked before enabling. Badging and suggestions to change email preferences remain deferred.

**Excluded initial scope.** Share images showing position distributions and a separate quotation model using post IDs and ranges are deferred or removed. Sharing starts with textual metadata and a fixed image. Deferrals are recorded, but comparative evaluation of each feature is not.

## 20 Keep registration input minimal

**Current design.** Creating an account currently requires an invitation; there is no public self-registration setting. Sign-in uses a six-digit email code entered in the requesting browser, a link confirmed in that same browser, or a passkey. Code and link share a fifteen-minute expiry and single use. Registration asks for username and main language; readable languages are optional settings. There is no separate writable-languages field. General post reading is controlled separately through `PUBLIC_READING`.

**Scope.** Member pages and saved mention destinations are implemented. Section 40 describes username rules and destination preservation. Limited registration input is separate from providing public registration or approval. Account deletion is implemented; section 33 describes its scope.

## 21 Do not require AI-use declarations for posting

**Current design.** The composer does not ask about AI assistance, and ordinary posts have no AI-use badge. Explicit `ai_assistance` from frontmatter or APIs remains optional machine-readable metadata. Absence does not become a recorded None. Routing and last-client records are separate.

**Rationale and rejected option.** Self-reporting becomes weak data if readers discount declared assistance and authors stop selecting it. Marking only API drafts would single out people using their own AI. Removing the old field also reduces input. The last client appears in the member's confirmation view, not as a separate public badge.

## 22 Align machine-readable reading with the interface

**Current design.** Markdown, IDs, change feeds, guidance and APIs provide the machine layer; the human interface offers one Open with AI action. There is no dedicated reading pack or custom CLI. Position distributions are not embedded in thread Markdown; explicitly fetching a distribution is treated as choosing to see results first.

Machine-facing details should not clutter manual reading, while AI representations stay aligned with the same posts and revisions. A member's unnamed position is excluded from ordinary Markdown. Position distributions are also excluded from change feeds and manifests. Detailed comparative reasons for not building a custom CLI are not recorded.

## 23 Limit external AI writes to drafts

**Current design.** APIs and MCP provide reading and drafts, not publishing, positions, reactions, reports or appeals. Drafts bind to the member and originating client, excluding browser and other-client drafts. Members publish through the browser after checking full text, destination, changes and last client. Per-member limits span Web, API and MCP.

**Rationale and limits.** External credential permissions enforce the boundary that people take responsibility for content published in their names. Personal unnamed positions and their history are not provided. This boundary proves neither comprehension nor that AI cannot operate a browser.

## 24 Change post signing from mandatory to optional

**Current choice and former policy.** Mandatory passkey signing for named posts, replies, edits and renames, with enrollment before the first post, was replaced by a member preference that defaults off. Ordinary posts need no additional confirmation; AI-last-edited drafts retain full-text confirmation. API and MCP gain no publishing permission.

**Reason for change and retained boundary.** Repeated passkey requests raised the barrier to writing. When signing is chosen, a roughly two-minute single-use challenge binds member, operation, content, destination and revision. Verification, consumption, mutation and evidence storage share a transaction. Toggling signing and deleting a key still require signatures. Signing proves neither reading, comprehension nor exclusive human use of a key.

## 25 Keep optional signing separate from key protection

**Current design and operating requirement.** Adding to an existing key set requires verification with an existing key; deletion requires a signature. The last key cannot be deleted. Enrollment history prevents bypass through supposed first enrollment. Total key loss uses identity review, a reason record, session revocation, a short re-enrollment window and email notice.

**Rationale and scope.** Optional post signing does not relax replacement or deletion of credentials into ordinary-post authority. General email-only recovery remains a separate design problem. Allowing members without keys to post is consistent with protecting the last enrolled key.

## 26 Enforce boundaries on MCP connections and consent

**Current design.** The same Node server exposes `/mcp` through personal Bearer tokens and OAuth. Host and Origin are checked outside the SDK as well. OAuth acceptance conditions include PKCE S256, exact redirect URI matching, DNS checks and destination pinning for client metadata and keys, rejection of internal addresses and redirects, and credential rejection after revocation.

**Record limits.** Consent and connections use the member's language, showing client identity sources and warning that display names alone are not trustworthy. Dynamic client registration (DCR), including unauthenticated registration, is always enabled, with no operator on/off setting. Registration is separate from member authentication and consent. Token-first, OAuth-second implementation order is recorded without comparative reasons against other methods. Supported protocol versions belong to implementation and connection checks.

## 27 Make AI reading credentials short-lived and narrowly scoped

**Current design.** Open in AI creates a URL on a same-Origin POST when clicked. A publicly readable resource has no credential and receives an `o` marker for return checks; the marker grants no access. A protected resource uses a member-issued five-minute `oai2` credential bound to path and query. Initial HTML and loaders contain no delegated key. Links inside returned Markdown never inherit `k`.

**Rationale and limits.** This narrows the former long-lived protected-reading links and avoids unnecessary credentials for public resources. A recipient can read through a delegated URL during its validity, so treat it as secret. Expiry does not recall content already sent to an AI. MCP authenticates with neither these URLs nor cookies.

## 28 State the exact privacy boundary of unnamed positions

**Design and operating policy.** Other-member interfaces, ordinary Markdown, APIs and MCP do not expose who selected which position. Personal views and exports are separate. The database retains member associations, so privacy is not cryptographic anonymity. Operators commit not to inspect or use individual positions; observation views and operational exports aggregate across questions.

**Rationale and limits.** With one or two people in a language group, question-level counts can reveal individual positions and discourage opposition to operators' questions. Removing names alone does not establish non-identifiability. Operational observation is separate from research processing, disclosure and any required review. Timing and linkage risks and administrators' technical database access remain; an operating commitment is not proof of inaccessible data.

## 29 Do not judge success by cross-language insight alone

**Evaluation limits.** Read aggregates with their numerator, denominator, population and observation period. A zero denominator means unobserved, not proof that there were no reactions or changes of view.

**Rationale and scope.** One-way assimilation could look successful on insight alone. Operational observation is separate from inspecting individual positions and must not break data down enough to reveal individuals in small groups. Having aggregates does not mean the community's success or diversity has been measured or demonstrated.

## 30 Keep the initial implementation and testing structure small

**Technical choices.** The implementation uses TypeScript, React Router framework mode, PostgreSQL with pgvector and a custom job queue. The supplied deployment configuration uses one server and Docker Compose. PGlite supports development and some tests; real PostgreSQL checks database behavior and concurrency. Alternative questions use `alt_of` rather than another relation table.

**Alternatives and record limits.** Discourse and pg-boss were not selected; the software uses a custom forum and database job queue. Comparative reasons for these product and queue choices are not sufficiently recorded, so performance or superiority is not invented as a retrospective rationale. The initial structure is not large-scale operating evidence.

## 31 Align stored rendering, language and logging boundaries

**Current design.** Fixed text such as footnote labels follows the body language, not the reader's UI language. External images become links; images uploaded and re-encoded by this site can be embedded. Responses use nonce-based CSP and security headers. Member HTML avoids shared caches, and logs mask query data and invitation tokens.

**Rationale and scope.** Rendering is stored per post and translation; varying fixed text by reader locale would make the stored representation unstable. Section 43 separates image processing and delivery conditions. Header presence is not proof of overall security.

## 32 Keep fake engines out of production

**Current design.** Deterministic fake translation and embedding engines support development without credentials. Production refuses a fake-engine configuration; staging permits one only explicitly. Missing alternative and judging engines mean no divergence measurement.

**Rationale and limits.** This separates reproducible development data from functions handling real member content. Passing tests with fake engines is not evidence of actual translation, semantic-search quality or cross-engine observations.

## 33 Preserve exit and post visibility boundaries

**Principle and current implementation.** Personal export, deletion through settings and operator deletion procedures are available. Members choose to retain posts under a shared departed-member identity or hide them for scheduled erasure. Their chat messages are deleted, including in former villages. Daily maintenance erases author-deleted post text and revisions after thirty days, with exceptions for hiding, operator deletion, unresolved appeals and preservation holds. Handled review evidence has individual 180-day conditions. This does not implement comprehensive erasure or general draft expiry. Export version 15 includes consent records, the current avatar, current icons of owned villages, private `saved_topics`, and notification registration counts, coarse labels and dates (without endpoints or keys). See [architecture](architecture.en.md#91-current-retention-and-deletion) for scope and limits.

**Visibility.** `PUBLIC_READING=1` makes eligible existing and new posts readable: topics without a village or in public-kind villages with URLs. There is no creation-date boundary preserving earlier posts as member-only. Per-post visibility and closed villages are unimplemented. Software licensing, content publication and permission to reuse posts remain distinct; the software's AGPL does not automatically license member content.

## 34 Separate community operation from promoting one framework

**Operating and public-document policy.** The operator named in participation terms should align with the contracting entity for APIs receiving participant data. Operator identity, terms, privacy notices, contacts and participation conditions are configured per site through [Operator settings](deploy.md#operator-settings). Rules have explanations, appeals and review dates. Public explanations use the community's own terms; a work's distinctive vocabulary is not made the initial glossary standard.

**Rationale and scope.** The community should not appear to exist to promote one ideology or work, nor impose an operator's framework through translation. Actual staffing and contracts are site-level conditions. A policy alone does not establish distributed authority or completed contracts.

## 35 Distinguish test notices, participation and public reading

**Operating distinction.** Test notices (`TOMOLA_SITE_STAGE=test`), site participation conditions, public reading and general registration are separate. A test notice does not change read permissions or participation conditions. Current code can open existing eligible posts through `PUBLIC_READING`, but has no approved general-registration flow. A setting's existence does not establish readiness for members, disclosure review or readiness to open a site.

**Required scope of checks.** Actual client connections, passkeys on supported devices, restoration, data-destination/usage terms and languages need checks under actual deployment conditions. Signed and unsigned member paths are separate. Test counts, completed design documents or storage in a particular region alone establish neither readiness for members nor all processing locations.

## 36 Keep future integrations outside current permissions

**Future direction.** External-format imports, person follows, quote posts, marked AI proxy replies, MCP Apps, WebMCP and connector listings are separate from the current minimal version. Personalized reading order is intended to belong to members' own AI rather than opaque platform recommendation.

**Rationale and conditions.** Actual usage informs additions considered as separate changes. A future one-time transfer of member-selected records would require explicit browser authorization bound to member, client and target, not a GET or blanket time window. This idea does not mean current MCP can read personal position records.

## 37 Consider software identity and continuity of the community

**Design and operating policy.** The software and first community use the name tomola. Other operators can use the software, so code provision is distinct from a particular community's name, domain and operating role. Domain management supports community continuity.

**Rationale and change.** An initial plan to choose a different community name was replaced by assigning the name to the community at the design's core. Administrative access is distinct from succession rights or protection against unilateral action. Authority, recovery contacts and continuity terms remain explicit site-level responsibilities.

## 38 Keep source availability and authorship durable

**Publication policy.** The software uses [AGPL-3.0-or-later](../LICENSE) and the copyright notice The tomola Authors. The implementation shows a source link when `SOURCE_URL` is set, and a build revision in the footer and `/readyz`. Displaying these values does not itself complete source provision or the preparation of its actual destination. The collective name is not a substitute legal entity and does not erase the rights of actual authors or organizations.

**Rationale and limits.** Offering corresponding source to people interacting over a network with modified software aligns with explainable and contestable rules. The license text governs the details. Recorded limits include enforcement difficulty, publishing anti-abuse code and potential reluctance to adopt the software. Collective attribution survives changes of operator or scale, but actual authorship and rights still need separate treatment.

## 39 Choose code and document languages for their readers

**Public-document policy.** Comments, test names and the general README use English for international maintainers. Japanese remains the reference text for design, with corresponding English architecture and rationale documents. Meaning-changing revisions update both versions.

**Rationale and change.** Respecting members' native-language posts is distinct from choosing a common language for code maintenance. Reasons embedded in comments should remain readable. The initial Japanese-design-plus-English-README approach expanded into bilingual public design documents to retain reasoning. Translating comments or strings does not itself complete behavioral checks or native-speaker review.

## 40 Separate username changes from destinations written in posts

**Current implementation.** Usernames normalize to lowercase ASCII letters, digits, `_` and `-`. A first rename is allowed at any time; subsequent new names require ninety days. Previous names are reserved for ninety days against other members' registration or renaming. Members may return to an active own reservation during the waiting period without changing the ordinary-rename timestamp. Member pages show displayable owned topics and an owned non-question introduction selected by the member. They are member-only and expose neither personal unnamed positions nor an overall reaction score.

**Destination preservation and limits.** Literal `@old-name` text remains in the original while the resolved recipient's public ID is saved. Mention links lead to the current name; name reuse and rerendering do not retarget another person. Translations use revision-bound saved mentions too. Renaming does not rewrite past source text. The properties of this implementation alone do not explain the choice of ninety days.

## 41 Separate village membership from post visibility

**Current implementation.** `VILLAGES=1` opens personal, language and member-created shared villages. A personal village is addressed as `@handle`, and only its owner can start topics. Freely joined `open` and member-posting `invite_public` are both public kinds. Owners invite members; joining and co-ownership require the recipient’s acceptance. Creation, co-ownership, invitations, leaving, ending, reports/actions, appeals and history are implemented. Topics select the member's own personal village or an active joined shared village. Unspecified destinations resolve at publication to the member's default or personal village. Replies inherit the root topic's place. See [MCP connections](guides/mcp-connect.md#village-destinations) for draft omission and `null` semantics.

**Boundaries and limits.** Signed-in members can read paginated rosters in shared non-language villages, including ended villages. Language villages show counts only. Signed-out pages, machine-readable outputs and member profiles omit rosters. Invitation acceptance and joining screens explain name visibility. Shared-village membership controls starting topics and using chat. Signed-out reading of public kinds still depends on `PUBLIC_READING`; any member can reply. `closed` exists in the schema without creation/reading flows. Shared `publicTopicPlace` excludes closed and unaddressable villages from ordinary reads. Enabling the setting requires placing existing data and passing startup consistency checks.

## 42 Separate ordinary chat access from review reads

**Current implementation.** `VILLAGE_CHAT=1` requires `VILLAGES=1`; ordinary reading needs current membership and village consent. Owner/operator roles do not grant ordinary reading. Report/appeal review checks authority before reading a target and context, recording reason, ranges and versions. Additional expansions need reasons and are limited to three per reviewer per case.

**Retention and limits.** Messages, consent, read cursors, translations and review snapshots are separate records. Leaving can retain past messages. Members can read, export and delete their own messages; deletion is not immediate erasure of review snapshots. Chat is excluded from public Markdown/API/MCP/search. SSE signals carry no bodies; cross-process synchronization relies on periodic fetches.

## 43 Separate canonical Markdown from editing and image derivatives

**Current implementation.** Rich and Markdown editing save the same canonical Markdown. Math and frontmatter use Markdown editing, and mode controls do not convert an unchanged original. JPEG/PNG/WebP uploads are inspected in an isolated process, oriented/resized and re-encoded to metadata-free WebP, with converted bytes stored in the database.

**Properties and limits.** Editor round-trips and image conversion do not guarantee lossless handling of arbitrary formats. Animation is rejected. Input, processing time/memory, output size and member/site storage are bounded. Image delivery checks references from the uploader's own posts and visibility; unused images are personal. Existing device caches and downloaded copies cannot be recalled. See [architecture](architecture.en.md#24-images) for values and deletion entry points.

## 44 Distinguish external model purposes and sending conditions

**Current implementation.** Translation, figure label reading/translation, embeddings, consented chat translation, AI spam classification and report preparation have distinct purposes, settings and inputs. With `FIGURE_TRANSLATION=1`, figure reading sends stored WebP bytes externally and translates extracted labels into image variants. It retains original figures, displays them on failure and shares the ordinary post budget and queue. Spam AI reads suspicious ordinary writing, never chat. Report AI reads targets, bounded context, reasons and explanations, producing priorities and preliminary assessments rather than deciding report dispositions.

**Consent and accounting.** Chat preparation needs consent version 2 or later from each target/context author. The current consent screen records version 3, states the conditions every provider must meet, and refers to the privacy notice for the current providers and countries. Consent is rechecked before sending and reads are audited. Chat translation has separate accounting; moderation shares ordinary post accounting. Provider locations, retention and training conditions do not follow from the database location. [Architecture](architecture.en.md#61-external-model-inputs-and-settings) lists settings and inputs.

## 45 Distinguish existing findings from new violations

**Current implementation.** Documentation, no-database, focused, integration and release checks have separate entry points. ESLint and disclosure checks record existing findings in file/rule baselines and fail on increases. JavaScript budgets limit both total size and growth from the previous baseline. Verification records fingerprints, SHA, settings and exit state.

**Properties and limits.** Existing findings in a baseline are not fixed defects, and pattern scans do not establish suitability for publication. A browser quarantine registry allows one retry only for registered cases with a cause and repair deadline; the current registry is empty. Failures and recoveries remain recorded. These checks do not replace usability on real devices, real-model quality or actual deployment checks.
