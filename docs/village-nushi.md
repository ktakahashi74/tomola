# Village Nushi

Nushi is an operator-provided AI that searches a village's public posts and answers a member's published call with a public, sourced AI reply. It reads a limited range and does not represent residents, owners or the operator's views. The operator is responsible for its answers. See [/ai-use](/ai-use#nushi) for the current provider, model and prompt version.

## Availability and stopping

`VILLAGE_NUSHI=1` enables the feature. It defaults off. Public reading and villages must also be enabled. Open and invitation-only public villages have Nushi by default; their owners can turn it off on the village page. Personal villages default off; the owner can opt in under Nushi in account settings. Language villages, closed or ended villages, and topics without a village cannot use it. Topic authors can prevent answers in their topic.

Turning off a village or topic setting cancels pending requests and permanently hides existing answers, retaining their positions and human replies. Enabling it again allows new requests. The global switch cancels pending requests and hides all answers; turning it back on restores answers that were not separately withdrawn. Workers expire requests and apply the global stop before claiming more work. Reads independently enforce the switch.

Readers can hide answers on their own screen. Members save this preference in their account; visitors save it in a device cookie. This does not stop generation or affect other readers.

## Calls and material

A member publishes `@nushi` or `@village-ai` in a new topic or reply. The composer explains that the answer will be public and offers a per-post opt-out. Quotes, fenced and indented code, inline code, escaped mentions, links, drafts, edits and translations do not invoke Nushi. Repeated calls in one post create one request. Both names are reserved, without creating an AI member account. Suggestions appear only in an eligible posting context; chat does not call Nushi.

The calling post, its parent and topic must be publicly readable. Retrieval uses the existing literal and multilingual semantic search, filtered to that village before limiting results. At most 20 result posts supply up to 24,000 characters of originals and available translations, with at most 8,000 per source field. Calling context is bounded separately. Previous AI replies are context, never evidence. Chat and other villages are excluded. Search terms and provider errors are not saved in jobs or logs.

Answers contain at most four short readings and eight checked citations. Every citation must be an actual supplied passage; the server supplies the author and destination. Originals and supplied translations are shown together, with dates and former-membership information. A quotation check establishes the existence of a passage, not correctness, fairness or adequate context. Long answers fold behind a read-more control. A missing result means only that it was not found in the consulted range. Questions about current beliefs or new agreement direct the caller to ask the person.

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
