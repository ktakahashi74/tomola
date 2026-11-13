# Private AI questions about posts

Eligible signed-in members can follow **Ask this site's AI about this post** on a readable post. The separate `/t/:id/ask` page answers questions about wording, translations and passages. It does not create a public AI participant, post, notification or reaction. The browser-only POST handler is `/t/:id/ask/action`; Markdown twins, API and MCP interfaces do not offer this feature.

The existing member and writing-eligibility gates apply to sending questions, reporting errors and saving reply drafts, including current participation consent and suspension restrictions. Anonymous readers never receive an entry link or an answer. The feature is disabled by default. Enabling it requires an operator to review the new data use and publish appropriate privacy information first.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `POST_ASK_AI` | unset | Set `1` to enable the entry, question page and POST handler. Unset or `0` disables them. |
| `POST_ASK_AI_MODEL` | Primary translation model | Use a model from the configured primary translation provider. Its existing key is reused. |
| `POST_ASK_AI_LLM_MONTHLY_BUDGET_USD` | `10` | Independent application-accounted monthly budget for post questions. `0` stops calls. |
| `ASK_AI_MEMBER_DAILY_LIMIT` | `10` | Question attempts per member per UTC day, shared by question entry points. |
| `ASK_AI_IP_LIMIT` | `6` | Requests to generate answers per trusted client address in a fixed window. |
| `ASK_AI_IP_WINDOW_SECONDS` | `600` | Length of that fixed IP window. Proxy handling follows `TRUSTED_PROXY_HOPS`. |

Rate settings must be positive integers, at most 1,000,000. Budget settings must be non-negative finite decimal numbers representable as integer microdollars. Invalid enabled settings fail startup. Configuration is read on the server; never put model keys in browser code.

Ledger purpose `ask` has its own budget group, independent of public translation/moderation and chat. Admission and settlement use the existing atomic reservations. These are application accounting limits with conservative estimates, not a provider-enforced billing cap. Failed requests can still consume the daily allowance; a returned refusal or truncated output with reported usage is charged. No automatic paid answer retry is made. `ask_village` is reserved as a separate allowed ledger purpose for a later feature and is not called here.

## Materials and verified quotations

Materials contain the post's original title/body, its selected translation into the reader's display language when available, and up to forty oldest readable replies with those translations. The shared visibility policy excludes deleted/hidden entries, deleted/hidden roots and unavailable places, including when the reader could otherwise review hidden content. Other threads, private drafts, images and linked pages are not retrieved. The total text limit is 24,000 UTF-16 units, with an 8,000-unit limit per original or translated field. Unicode boundaries are preserved. Omitted text or replies produce an explicit range warning; a limited range cannot establish absence from the whole discussion.

A fixed system instruction is separate from a JSON envelope containing the question and untrusted materials. The provider has no browsing, publishing or delivery tools. JSON output must use supplied source IDs and exact original quotations; a supplied translation requires a checked quotation from that same translated field. The server normalizes whitespace and canonical Unicode, then checks substring existence. Unknown sources, invented/missing translations, extra output fields and quotations outside the structured citation fields withhold the whole answer and increment verification-failure counts. Word-internal apostrophes in prose are allowed.

The server supplies author labels, post/reply categories and local source links. Model output supplies none of these destinations. The page separates literal passages from the post, author-attributed reply passages, and generated **AI's reading**. Text is rendered as text, without model-supplied HTML, Markdown images or active links. Cited materials are checked again after generation; an edited, hidden or removed cited source withholds the answer. Unrelated new replies or translations do not invalidate unchanged citations. Quotation existence does not establish semantic correctness, accurate interpretation or the absence of all prompt-injection effects. Evaluation still needs people reading across languages.

## Storage and error reports

Normal questions and answers live only in the requesting browser's transient component state and the in-flight request. They are not written to conversation records, jobs, application logs, browser storage or shared caches. The page has no history lookup. Responses are private and not cacheable. POST forms also keep question text out of URLs before hydration. Provider and content-bearing database errors are converted to fixed error codes without logging their detail.

Choosing **Ask the writer this question in a reply** explicitly saves the question text as the member's own ordinary reply draft. It does not copy the AI answer or publish anything. The member reviews and submits it through the existing draft/signing flow.

Choosing **Report an error in this answer** first reveals an unchecked consent box. Only an agreed submission stores the question, verified answer, source target and reporting account in `ai_question_reports`. A signed, hour-lived receipt binds the transient answer to its member, target, question, model, language and range; it is not a server-side conversation identifier. Other members cannot reuse it. Reporting neither sends email nor publishes content.

Operators can open the report page from `/admin/metrics` at `/admin/ai-question-reports`. It shows the latest fifty reports within the retention period and aggregate operational counts. It remains available to operators when generation is switched off. Ordinary members receive no report listing. Reports become eligible for deletion after ninety days in the existing bounded maintenance cleanup; preservation holds pause deletion as they do for other retained records. Account or target deletion can remove reports sooner.

Question sends, verification failures, draft creation and actual reply publication use anonymous daily numeric counters in the existing expiring counter store. Member allowances use a purpose-independent keyed hash with no post identifier. IP allowances also use a keyed hash, derived separately from member allowances, and expire after their configured window. Raw IP addresses are not stored in these allowance keys. The cost ledger contains model, purpose and token/cost numbers. A numeric draft marker supports publication counts without storing question or answer content in analytics. Counters and markers expire after the cost-ledger retention period, currently thirteen months; publication attribution ends when its marker is removed. These are operational observations, not success or answer-quality measures.

Use fake primary engines, fake embeddings, local mail fixtures and an isolated test database for verification, as described in [Development and verification](development.md). Never point feature tests at a member database or call real model APIs without separate approval.
