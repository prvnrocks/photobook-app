# Privacy, data handling and AI cost controls (Task 9)

What we store, where, who else receives it, how it is deleted, and what we cannot delete. This is an
engineering record, not a legal document — the user-facing text is `/privacy`
(`src/app/(marketing)/privacy/page.tsx`, still a draft under legal review). We claim no certifications.

Items marked **VERIFY BEFORE LAUNCH** could not be confirmed from this repository and must be checked
against the provider's current terms by a human.

## 1. AI provider configuration

- Provider: **Anthropic, Claude API** (commercial API, project API key `ANTHROPIC_API_KEY`, server only —
  `src/lib/ai/client.ts`; `tests/boundaries.test.ts` keeps the key out of client code).
- Training: under Anthropic's **commercial terms**, inputs and outputs sent through the API are not used
  to train models unless the customer opts in (e.g. a feedback / development-partner programme). We do
  not opt in to any data-sharing feature; the transport sends only the model request (`effort`,
  structured output, and the server-side refusal fallback beta). **VERIFY BEFORE LAUNCH** that this is
  still the wording of Anthropic's Commercial Terms and that no org-level setting in the Anthropic
  Console enables sharing.
- Retention at Anthropic: Anthropic documents that API inputs/outputs are retained for a limited period
  (and longer when flagged by its trust & safety systems) and then deleted. **VERIFY BEFORE LAUNCH** the
  exact current number of days and the flagged-content exception; the privacy page deliberately says
  "a limited time … under its own retention rules" without a number.
- **Zero data retention (ZDR) is NOT assumed.** ZDR is an opt-in arrangement Anthropic offers to
  eligible customers by agreement; this project has none. If one is arranged later, update this file
  and the privacy page.
- Region: requests go to Anthropic's API (United States processing per `src/lib/legal/processors.ts`).

### What is sent to the AI

| Flow | Sent | Never sent |
| --- | --- | --- |
| Photo description (storybook, `src/lib/ai/photo-intelligence`) | the 512 px **AI copy** of one photo — re-encoded server-side with all metadata (EXIF / GPS / XMP) stripped (`src/lib/photos/ingest-verify.ts` `prepareAiCopy`), base64, ≤ 10 images per request | originals, web copies, GPS coordinates, file names, user ids |
| Album pipeline (classic) | 512 px thumbnails, dates, place names, book title, caption preferences, confirmed names | originals, GPS coordinates |
| Story plan / chapter writing / rewrites (`src/lib/ai/story`) | the AI's own photo descriptions (text), dates, place names, the user's story answers, chapter outline, book title | images (none), GPS coordinates |
| Page compose intent | photo aliases + sizes, page outline, template catalogue | photo ids (aliases only), text of the user |

Models (Task 9, cost): photo descriptions default to the smaller `claude-sonnet-5-5`
(`AI_PHOTO_MODEL`); narrative writing keeps the stronger `claude-opus-5-5` (`AI_STORY_MODEL`). The classic
album pipeline is unchanged (`AI_MODEL`). `claude-haiku-5-5` is not selectable: its price and its
support for `effort` / server-side fallbacks could not be verified here.

## 2. What we store, and where

| Data | Where | Access |
| --- | --- | --- |
| Photo original, web copy (≤ 1600 px), thumbnail = AI copy (512 px, metadata-free) | Supabase Storage bucket `photos`, **private** (`public = false`), path `{user}/{book}/…` | owner via RLS-scoped policies (`storage.foldername(name)[1] = auth.uid()`), everyone else only via **short-lived signed URLs** made on the server: editor 1 h, review / cover thumbs / PDF downloads 10 min, ingest reads 60 s, public viewer (published books only) 6 h |
| PDF exports | bucket `exports`, private, `{user}/{book}/{export}.pdf` | owner via signed URL (10 min) |
| Print package (Task 10) — cover PDF + inside-pages PDF cut from a ready export | bucket `exports`, private, `{user}/{book}/{export}-cover.pdf` / `-interior.pdf` | owner via signed URL (10 min), paid books only; removed with the book, when a newer PDF supersedes the export, or by the orphan sweep 7 days after they were made |
| Books, captions, story versions, story answers | Postgres (`books`, `storybooks`, `storybook_versions`) | owner (RLS) |
| AI photo analyses (descriptions) | `photo_analyses` (service role only) | server only; deleted with the photo / book / account |
| AI call logs | `agent_steps`, `story_ai_calls` (service role only; no prompts or narrative text) | server + admin trace page |
| AI usage ledger (Task 9) | `ai_usage_ledger` — numbers only: operation, model, tokens, cost, priced flag, latency, status (ok / failed / refused / retried), attempt, cost bucket | service role only; **kept** when a book is deleted (book id set null) so spend caps can't be reset by deleting books |
| Storybook job state | `agent_runs.cursor` (service role only) — the plan and, for a finished **preview**, its written chapters (so "Complete my book" reuses them) | scrubbed to `{}` when the book is deleted (trigger from migration 0700) |
| Entitlement grants (Task 9) | `book_entitlements` (service role only) | operators only (`src/lib/entitlements/grant.ts`, ADMIN_USER_IDS) |
| Rate-limit counters (Task 9) | `private.rate_limit_windows` — `'<route>:<hash of user id>'` + counts | service role only; windows older than 24 h deleted by the daily cron (Task 10) |
| Monitoring (Task 10) | nothing new is stored: `/admin/monitoring`, `/api/admin/monitoring` and `scripts/monitoring-summary.mjs` read codes, counts, money and timestamps from `ai_usage_ledger`, `agent_runs`, `exports` | admins only (ADMIN_USER_IDS) / service role; daily `[monitor]` log lines carry codes and numbers only |

Logging: no console call may log photos, descriptions, captions, story text, prompts, titles, e-mail
addresses, GPS / EXIF, paths, URLs (incl. signed URLs), secrets or raw error messages — enforced by
`tests/privacy/no-sensitive-logging.test.ts`. Logs carry route tags, error codes and counts.

## 3. Deletion paths (systems under our control)

| User action | What is removed |
| --- | --- |
| Delete a photo | storage objects original + web + thumbnail (= AI copy), the row; cascades: `photo_analyses`, `photo_ingest`, `photo_quality`; the photo is stripped from the book doc |
| Delete a free book (dashboard) | the book row (`delete_book_guarded`) → cascades photos, `photo_analyses`, storybooks + versions, `story_ai_calls`, exports rows, organiser tables, grants; then storage prefixes `{user}/{book}/` in `photos` **and** `exports` (originals, web copies, AI copies, PDFs). Agent runs keep only numbers (cursor / progress / step outputs scrubbed by trigger). Storage failures are retried by the daily orphan sweep |
| Delete the account (Settings) | every book as above, then the auth user (cascades the rest); ledger rows keep no user id |
| Revoke a share link (Task 9) | "Turn off and make a new link": `published_doc` and `slug` cleared — the old `/b/<slug>` link never works again; the next publish creates a new slug; the free-link expiry does not reset |
| Automatic | expired free books, abandoned drafts, pending uploads, orphan objects (incl. print package files after 7 days), old exports, rate-limit windows (daily cron, `src/lib/cleanup`) |

Paid / comped books can't be deleted one by one (payment records); the account deletion path covers them.

## 4. Exceptions we cannot delete on request

- **Database backups / point-in-time recovery (Supabase):** deleted rows and objects remain in backups
  until those backups age out under the plan's backup window. **VERIFY BEFORE LAUNCH** the project's
  backup / PITR retention days.
- **Anthropic:** copies of AI requests/responses retained under Anthropic's own policy (section 1). We
  cannot recall them.
- **Stripe:** payment and customer records are retained by Stripe as required for payments, fraud
  prevention and law.
- **Mapbox:** receives one GPS point per photo cluster for reverse geocoding (no photos); retained per
  Mapbox's terms. **VERIFY BEFORE LAUNCH.**
- **Vercel:** request logs (IP, user agent, path — our logs carry no content) retained per the Vercel
  plan's log retention.
- **Resend / PostHog / Sentry:** e-mail delivery records, anonymous usage events, scrubbed error reports,
  per their retention settings.
- **Our usage ledger:** number-only AI cost rows stay after deletion (no photos, text or book link).

## 5. Free preview and entitlements (Task 9)

- `getBookEntitlement(bookId)` (`src/lib/entitlements`) is the one place that answers "what may this
  book do": `tier` preview | full, `source` stripe | comp | grant | none, `canExportPdf`.
  Facts come only from the server: `books.is_paid` (set only by the Stripe webhook / `comp_book`),
  the paying order's status, and an active row in `book_entitlements`.
- A **grant** unlocks full storybook generation only. It never unlocks the PDF, the watermark-free
  viewer or the permanent link (`canExportPdf` = `is_paid`; `create_export_job` re-checks `is_paid`).
- Without a full entitlement, a storybook job makes a **4–6 page preview** (`AI_PREVIEW_PAGES`,
  default 5): the photo analysis and the plan cover the whole book (planned for the paid page limit),
  but only the chapters on the preview pages are written and the composer is capped to those pages.
  Publishing an unpaid storybook never shares more than the preview pages.
- Live preview runs per book are capped (`AI_PREVIEW_MAX_RUNS`, default 3 = first + 2 regenerations;
  counted server-side from finished live preview runs → `402 preview_limit`). Per user, the existing
  daily live-run cap (D-026) and the spending caps apply.
- After payment, **Complete my book** starts a job that continues from the preview's plan and chapters:
  cached analyses (no model call), no new plan, only the remaining chapters written.

## 6. Cost controls (Task 9)

- **Pricing** — `src/lib/ai/pricing.ts` defaults + `AI_PRICING_JSON`; an unknown model is costed at the
  highest known rate and flagged `priced = false`, never $0.
- **Ledger** — every model attempt of every operation (album agents, photo analysis, plan, write,
  repair, rewrite, compose) → `ai_usage_ledger` with model, input / output / cache tokens, latency,
  estimated cost, status and attempt number (retried attempts are separate rows) and `cost_bucket`
  (`preview` = free storybook preview, `paid` = entitled books, `other` = classic free album).
  Report: `admin_ai_usage_by_bucket(p_days)`.
- **Caching** — photo analyses are cached by (user, SHA-256 of the AI copy, model, prompt version);
  rewrites read stored analyses and never re-analyse.
- **Caps** — per book (preview $2 / full $15) and per user (day $20 / month $100), env-configurable
  (`AI_CAP_*`), checked before every live call; plus the global daily budget (D-059), per-run ceiling
  (D-035), per-book call limits and daily run caps. Caps fail open only if the totals can't be read.
- **Rate limits** — Postgres fixed windows per user on storybook start / tick, story rewrite, album
  runs, ✨ rewrite, photo finalize and Stripe checkout → `429` + `Retry-After`.
