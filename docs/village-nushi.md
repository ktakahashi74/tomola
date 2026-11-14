# Village Nushi

Nushi is an operator-provided AI that searches a village's public posts and answers a member's published call with a public, sourced AI reply. It reads a limited range and does not represent residents, owners or the operator's views. The operator is responsible for its answers. See [/ai-use](/ai-use#nushi) for the current provider, model and prompt version.

## Availability and stopping

`VILLAGE_NUSHI=1` enables the feature. It defaults off. Public reading and villages must also be enabled. Open and invitation-only public villages have Nushi by default; their owners can turn it off in village management on the village page. Personal villages default off; the owner can opt in under Nushi in account settings. Language villages, closed or ended villages, and topics without a village cannot use it. Topic authors can prevent answers in their topic.

Turning off a village or topic setting cancels pending requests and permanently hides existing answers, retaining their positions and human replies. Enabling it again allows new requests. The global switch cancels pending requests and hides all answers; turning it back on restores answers that were not separately withdrawn. Workers expire requests and apply the global stop before claiming more work. Reads independently enforce the switch.

Readers can hide answers on their own screen. Members save this preference in their account; visitors save it in a device cookie. This does not stop generation or affect other readers.

## Calls and material

A member publishes `@nushi` or `@village-ai` in a new topic or reply. The composer explains that the answer will be public when a call is present. Quotes, fenced and indented code, inline code, escaped mentions, links, drafts, edits and translations do not invoke Nushi. Repeated calls in one post create one request. Both names are reserved, without creating an AI member account. Posting suggestions appear only in an eligible context. Chat calls use the separate switch described below.

The calling post, its parent and topic must be publicly readable. The direct parent reply, calling topic and up to 40 other public replies in that topic, oldest first, precede existing literal and multilingual semantic search results, excluding the call itself and duplicate posts. They pass the same visibility and author-allowance checks as search results. The topic and its replies share at most half of the 24,000-character material budget, counting originals and available translations, with at most 8,000 per source field. Up to 20 further posts from village search can use the remaining budget. Omitted or clipped material is marked as truncated. Calling context is bounded separately. Previous AI replies are context, never evidence. Chat and other villages are excluded. Search terms and provider errors are not saved in jobs or logs.

Answers contain at most four short readings and eight checked citations. Every citation must be an actual supplied passage; the server supplies the author and destination. Originals and supplied translations are shown together, with dates and former-membership information. A quotation check establishes the existence of a passage, not correctness, fairness or adequate context. Long answers fold behind a read-more control. A missing result means only that it was not found in the consulted range. Only questions about a person’s current beliefs, new promises, permission or agreement direct the caller to ask that person. Other missing results omit that guidance. Older public replies retain their original guidance.

While an answer is pending, the screen says that Nushi is thinking. Its decorative dots animate in sequence and remain still when reduced motion is requested; the status announcement contains only the sentence. Posting pages load a small watcher only for pending calls. It reads only the request state, starting after two seconds and backing off to ten seconds, for at most 40 attempts or five minutes. It pauses and cancels in-flight reads while the tab is hidden, and refreshes page data on completion, failure or cancellation. The caller can check their request; other readers must pass the existing public visibility checks. Responses are private and not cached, and contain no question or answer text. Without JavaScript, reloading shows the latest result.

Each reading is limited to 1,200 characters and each quotation to 600 characters. The prompt states these limits and asks broad questions to select representative supplied posts and describe the selected range. A failed output check leaves the saved failure as `unverified`. Server logs contain only the request identifier, a fixed reason category and numeric reading/citation counts, never provider output, questions or quotations.

## Allowances and costs

| Environment variable | Default |
| --- | --- |
| `VILLAGE_NUSHI_MEMBER_DAILY_LIMIT` | 5 |
| `VILLAGE_NUSHI_TOPIC_DAILY_LIMIT` | 10 |
| `VILLAGE_NUSHI_VILLAGE_DAILY_LIMIT` | 30 |
| `VILLAGE_NUSHI_AUTHOR_DAILY_LIMIT` | 10 |
| `VILLAGE_NUSHI_CONCURRENT_LIMIT` | 2 |
| `VILLAGE_NUSHI_TTL_SECONDS` | 3600 |
| `VILLAGE_NUSHI_LLM_MONTHLY_BUDGET_USD` | 10 |
| `VILLAGE_NUSHI_MODEL` | Primary translation provider's configured model |

Allowances use UTC dates. Reservations serialize across processes. The author allowance counts only distinct authors actually cited in a published answer, excluding the caller. Topic authors and unused material do not consume it. Posts by authors who have reached the allowance are excluded from that day's material; the call can still proceed. Publication checks and reserves the cited authors under the shared quota lock, so concurrent answers cannot exceed the limit. A retry reuses that request's daily reservations. A changed date is checked again before publication. Requests have at most three generation attempts and a bounded processing lease. A unique request per calling post and a unique answer per request prevent duplicate publication after retries or restarts.

The `ask_village` ledger purpose has its own monthly budget, separate from private post questions and other AI use. Query embeddings, answers and answer translations reserve and settle against it. No change to other ledger-purpose constraints is required. Model output and material cannot change the destination, permissions, allowances or publication decision.

## Publication and withdrawal

AI replies live in dedicated tables. They have no member identity and do not contribute to human reply counts, stances, Insightful, active members, public statistics, related discussions, search results, embeddings or member exports. Topic lists show the AI count separately. AI answers do not advance topic activity or unread-topic markers. Human replies to an AI answer remain ordinary human replies.

Publication rechecks settings, expiry, allowances and all supporting source revisions under database locks. Database triggers withdraw answers and translations when supporting content is edited, deleted, hidden or moved, or when a relevant supplied translation changes. Follow-up answers are withdrawn when their AI context is withdrawn. Restoring a source does not restore an old answer. All screen, Markdown, MCP and JSON reads use the same visibility gate; content responses are not stored in the service worker cache.

The caller receives a result notification. Cited authors may receive one citation notification per UTC day and can opt out in account settings. Followers are not notified by AI replies. Notices and email contain only a short result label and link, never answer text. Immediate-email work is queued with the notification; database-triggered cancellations use a durable job handoff. Workers do not scan unemailed Nushi notices, and permanently failed delivery jobs are not recreated.

Source-attribution snapshots belonging to the member are included in personal exports, without other members' snapshots or AI answer text. Account deletion anonymizes their saved author labels.

## Reports and operational review

Members can send an ordinary moderation report with the existing reason categories. Error reports are separate and require explicit consent before saving the question, answer and exact bounded material. Error categories include missing disagreement, the wrong post, and lost quotation context. Members can inspect their reports and outcomes at `/nushi/reports`; operators can review reports and hide answers there. Open moderation reports and their count also appear at `/mod` for operators. Hiding an answer adds its number and reason category to `/moderation`, alongside other actions. Reporter identities are omitted from report screens. Error evidence is retained for the same 90-day period as private question reports; ordinary moderation reports use the village-report retention period. Retention holds apply.

The first prompt version is `nushi-v1`. Changes to the generation contract should increment that identifier, retain the previous version on existing answers, and update the public AI-use explanation and operator-maintained model history when applicable.

Use fake engines and synthetic posts for automated verification. Before enabling real use, separately approve and assess a small real-model evaluation of quotation context, missing disagreement, misleading premises, current-belief questions, instruction injection, criticism of the operator and cross-language retrieval. Automated quotation checks and fake-engine tests do not establish those semantic qualities.

## Private chat calls

`VILLAGE_CHAT_NUSHI=1` enables calls in an eligible village chat, independently of `VILLAGE_NUSHI`. Both switches default off. Chat still requires public reading, villages, village membership, the current chat consent and permission to write. Village owners use the shared Nushi setting; language villages cannot use it. Turning the chat switch off removes its controls, syntax-preview route, notices, the AI-use disclosure and maintenance scan without extra AI-table reads.

A new human message can call `@nushi` or `@village-ai`. The composer explains the external AI processing and destination when a call is present. Edits, quotes, code, translations and AI answers cannot call. Only the calling message passes through the same visible-text projection as public source material. Query embeddings and answer generation receive that message alone: neither its reply target nor adjacent chat is question context or evidence. When the subject cannot be established from that message, the answer asks the caller to describe it. Evidence remains limited to public human posts in the same village; the calling message’s assertions are not evidence.

Answers are chat messages with `author_kind = nushi` and no member identity, replying directly to the call at the end of the conversation. Requests and source provenance have separate private tables and never enter posting Nushi’s public reads, reports, Markdown, MCP or JSON. Request, job and usage records contain no copied question, answer, search text or provider error. The answer’s only ordinary storage is its chat message; explicit chat reports use the existing audited evidence boundary and retention policy.

The screen folds an answer when it exceeds eight rendered text lines, using the same layout measurement in every language. Opening it reveals the complete readings, attribution, qualifications and consulted scope; no shortened quotation replaces them. Translation changes only generated readings, keeping checked quotations and destinations intact. Reports on AI answer translations go to audited human review without an automatic whole-answer retranslation.

Links inside an AI answer that share the configured site's origin display a short open-post label. Their complete destinations, including quotation fragments, stay unchanged, as do the saved message and its report/translation evidence. External links and links in human messages keep their existing labels.

AI arrivals do not contribute to chat unread counts, village attention marks, “new messages” counts or human read receipts. They do not automatically scroll the screen or send device notifications. The log uses polite announcements. The caller receives one result notice instead of an additional reply notice. Cited authors receive a daily, text-free notice only while they can read the chat; posting and chat citation notices share the daily allowance. Replies to an AI answer are ordinary human messages and never notify an AI account.

Member, village, cited-author, concurrent and monthly cost allowances are shared with posting calls. Chat adds at most three admitted answers in ten minutes per village. Claims and publication use the shared quota lock; leases and unique message/request links prevent duplicate publication after a retry. Publication locks and rechecks the caller, consent, village, calling message and public source revisions. Calling edits or deletion cancel pending work; deletion after publication hides the answer, while a later edit adds a note. Source or supplied-translation changes permanently hide the answer, clear its translated display and redact loaded reply previews. Village shutdown hides answers and cancels pending calls. Global shutdown is enforced by jobs and reads without adding an off-state polling scan.

Chat consent version 4 always discloses conditional Nushi processing and its audience, including while chat Nushi is disabled. It also adds the direct reply target to ordinary human translation context and audited review of a reported message. Review follows that one reference only and records its identifier and revision in the access log. Deleted and hidden references fetched outside the surrounding review window are excluded; messages inside that window retain the existing review policy. Translation context excludes AI answers; human targets predating the current consent version follow the same policy as preceding context. Proposed principles and operator privacy wording are reviewed separately before enabling the feature.
