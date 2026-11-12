# Decision log (ADR-lite, newest at the bottom)

Format: `## D-NNN — title (YYYY-MM-DD)` → **Decision**, **Why**, **Alternatives rejected**. Never delete; supersede with a new entry.

## D-001 — Digital-first flipbook + PDF, print later (2026-11-03)
**Decision:** Main product is a shareable flipbook link + PDF; UAE printing after launch. **Why:** no print partner needed to launch; WhatsApp sharing drives growth.

## D-002 — Freemium per book, AED 39 (2026-11-03)
**Decision:** Free = watermark, 20 pages, 30-day link, no PDF. Paid = no watermark, 100 pages, permanent, PDF. **Why:** shared free books are free marketing.

## D-003 — Fixed-slot layouts, not free canvas (2026-11-03)
**Why:** 3–5x less work, works on phones, users can't make ugly books.

## D-004 — Stack: Next.js + Supabase + Stripe + Vercel + Claude API (2026-11-03)
**Why:** solo JS developer, fastest path, all free to start.

## D-005 — English UI, Arabic captions supported (2026-11-03)
**Why:** cheap to support from day one, expensive to retrofit; full Arabic UI later.

## D-006 — In-product AI = code-orchestrated agent pipeline, not free-chatting agents (2026-11-03)
**Decision:** Curator → Storyteller → Caption Writer → Critic, orchestrated by a TypeScript state machine, every step logged in `agent_steps`, per-user memory in `user_memory`. **Why:** predictable cost/latency (< 90 s per book), debuggable, each agent testable alone. **Rejected:** autonomous multi-agent chat (slow, costly, unpredictable).

## D-007 — Development via Agentic OS in Claude Code (2026-11-03)
**Decision:** Main session = orchestrator; specialist subagents (planner, frontend, backend, ai-pipeline, tester, reviewer); hooks log everything; memory files loaded at session start.

## D-008 — shadcn/ui v4 on Base UI + `cn` package; Node 22+ (2026-11-03)
**Decision:** Accept shadcn CLI v4 defaults (style `base-nova` on `@base-ui/react`, `cn` package from shadcn-ui instead of clsx + tailwind-merge). Components import `cn` via `@/lib/utils`. Require Node >=22 (`engines`), Vercel on 22.x/24.x. **Why:** current shadcn default; `cn` verified (maintainer shadcn, no install scripts); Vitest 5 and `cn` need Node 22. **Rejected:** forcing the legacy Radix style (fights the CLI on every `shadcn add`).

## D-009 — Supabase new API keys: publishable + secret (2026-11-08)
**Decision:** Use `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`) and `SUPABASE_SECRET_KEY` (`sb_secret_…`) instead of the legacy anon / service_role JWT keys. Secret key is read only in `src/lib/supabase/admin.ts` (server-only). **Why:** the project was created with the new key types; legacy keys are being phased out and can't be rotated independently. **Rejected:** keeping old variable names holding new keys (confusing).

## D-010 — Email login = token_hash link + 6-digit code; Google as second option (2026-11-08)
**Decision:** Email template links to `/auth/confirm?token_hash=…&type=email` (verifyOtp) and also shows the 6-digit `{{ .Token }}`, which the login page accepts. **Why:** most users come from WhatsApp on phones; PKCE `?code=` links break when the email opens in another browser, and Google blocks OAuth in embedded webviews. **Rejected:** default PKCE magic link only.

## D-011 — Server-only book fields and orders (2026-11-08)
**Decision:** A trigger forces `is_paid`, `max_pages`, `expires_at`, `slug`, `published_at` on books to defaults/old values unless the caller is the service role; publishing (M6) goes through a server-side step. `orders` are readable by their owner but written only by the service role; `orders.user_id/book_id` are `on delete set null` so payment history survives deletions. **Why:** never trust the client for paid status/expiry; keep financial records. **Rejected:** RLS-only (can't restrict columns), cascading order deletes.

## D-012 — Photo originals: JPEG for print, HEIC converted (2026-11-08)
**Decision:** Keep JPEG/PNG/WebP originals as uploaded when ≤20 MB; convert HEIC (or larger files) to JPEG quality 0.9, longest side ≤4096 px. Also store `web` (≤1600 px) and `thumb` (512 px). **Why:** Puppeteer/Chromium can't render HEIC for the PDF; 4096 px is ample for A5 at 300 dpi and fits iOS Safari's ~16.7 MP canvas limit. **Rejected:** storing HEIC + JPEG (2× storage, HEIC unusable for print). Note: originals keep EXIF (incl. GPS) — strip/re-encode in the PDF (M7).

## D-013 — Resumable upload = server-tracked fingerprints (2026-11-08)
**Decision:** Each file gets a content fingerprint; photo rows are inserted `pending` before upload and set `ready` after. On resume the user re-selects the photos; ready ones are skipped, pending ones retried. **Why:** browsers can't reopen files after reload; IndexedDB can't hold hundreds of MB reliably on phones. **Rejected:** IndexedDB file queue.

## D-014 — Upload cap per book: 150 free / 500 paid (2026-11-08)
**Decision:** Same numbers as the AI analysis limits, defined in `src/lib/ai/limits.ts`, enforced by a SECURITY INVOKER trigger on photos (advisory lock per book) and checked in the browser first. **Why:** keeps AI cost bounded; one source of truth. **Rejected:** higher upload caps than the AI limit. Known gap: caps are per book (multiple free books) — revisit M3/M9.

## D-015 — Place names via Mapbox v6, permanent storage (2026-11-08)
**Decision:** Server-side Mapbox v6 reverse geocoding with `permanent=true` (results may be stored in `photos.place`), one request per ~1 km GPS cluster, behind `src/lib/geo/reverse-geocode.ts` so the provider can be swapped. **Why:** Mapbox's standard (temporary) results may not be stored. Gives area/city names, not landmarks. **Rejected:** temporary results stored anyway (terms risk). User to confirm pricing in their Mapbox account.

## D-016 — Rule-based album written in M2 only if doc is empty (2026-11-08)
**Decision:** The finalize step runs `autolayout` and writes `books.doc` only when it is `{}`; AI replaces it in M3. **Why:** proves the fallback end-to-end and never overwrites user or AI work.

## D-017 — One finalize route instead of /api/geocode (2026-11-08)
**Decision:** `POST /api/books/[id]/finalize` does duplicate grouping, GPS clustering + geocoding and the fallback layout; idempotent (re-run costs no geocode calls). Dashboard cards link to `/books/[id]/upload` until the editor exists (M5).

## D-018 — Album origin marker; AI may replace drafts, never user edits (2026-11-08) — supersedes D-016
**Decision:** `doc.meta = { generator: 'rule'|'ai', generatorVersion, runId, userEdited }` (optional; missing = rule, not edited). The AI writes `books.doc` only when the doc is `{}` or `meta.userEdited === false`, via one conditional update with the `updated_at` lock. Curator/rule writes to photos skip `user_override = true`; a user-set `books.title` always wins; rebuild on an edited album is refused (409) until the M5 editor can merge per-page edits and `caption.source='user'`. **Why:** D-016 would never let the AI improve a rule-built draft. **Rejected:** keeping D-016.

## D-019 — Duplicate thresholds tuned on real photos; groups stay in one Curator batch (2026-11-08)
**Decision:** Tighten dHash/time thresholds using a histogram of the user's real 110-photo set (metadata only); batches of ≤10 never split a dup group; the Curator picks the best of each group and code guarantees ≥1 kept per group. **Why:** 48/110 photos grouped looked too aggressive.

## D-020 — AI never depends on place; iOS location hint (2026-11-08)
**Decision:** Prompts treat place as optional and forbid inventing places; date labels come from dates. Upload summary shows "turn on Location in the picker's Options" on iOS when no photo has GPS (copy verified on a real iPhone first). **Why:** 0/110 iPhone uploads had GPS.

## D-021 — AI status and usage counters are server-side only (2026-11-08)
**Decision:** `books.ai_status` gains `'partial'` and becomes server-only (protect_book_columns). Real status lives in `agent_runs`. No counter columns: rebuilds, analysed photos, builds/day and rewrites are counted from `agent_runs` / `agent_steps` / `photos.ai` (service-role writes only).

## D-022 — AI runs as client-driven, resumable ticks (2026-11-08)
**Decision:** `POST /api/ai/runs` creates a run; the progress screen loops `POST /api/ai/runs/[id]/advance`, which takes a DB lease, runs one idempotent chunk (a Curator wave, or the Storyteller, or validate+save) within a ~40 s budget, checkpoints, and returns progress. Closing the tab pauses; reopening resumes. **Rejected:** after()/waitUntil self-chaining, background queues (for now).

## D-023 — Short alias photo ids in prompts (2026-11-08)
**Decision:** Photo UUIDs map to `p1..pN` in prompts and back in code. **Why:** fewer output tokens/latency, invented ids are trivially detected, fixtures don't depend on real ids.

## D-024 — AI modes off | replay | live (2026-11-08)
**Decision:** `live` when ANTHROPIC_API_KEY is set; otherwise `replay` (recorded/synthesised answers) for local, tests and preview, and `off` in production (rule album + "AI not available yet"). Replay in production only with explicit `AI_MODE=replay`. **Why:** never show synthetic "AI picks" to real users. **Rejected:** replay everywhere.

## D-025 — AI endpoints are /api/ai/runs, not analyze/plan (2026-11-08)
**Decision:** `POST /api/ai/runs`, `GET /api/ai/runs/[id]`, `POST /api/ai/runs/[id]/advance`; PLAN Step A/B wording updated at checkpoint.

## D-026 — Daily AI build cap per user: 3 free / 20 paid (2026-11-08)
**Decision:** `maxLiveBuildsPerUserPerDay` in `src/lib/ai/limits.ts`, counted from `agent_runs`, on top of per-book limits. **Why:** closes the "many free books" gap from D-014.

## D-027 — AI trace privacy (2026-11-08)
**Decision:** Curator step logs store only ids/keep/reason/quality/scene/coverWorthy; descriptions only in `photos.ai` (deleted with the photo). Deleting a book nulls its runs' step outputs (costs kept). `/admin/runs/[id]` is limited to server-only `ADMIN_USER_IDS`; privacy policy must mention admin trace access.

## D-028 — Free "Update album" re-layout after review changes (2026-11-09)
**Decision:** After keep/drop changes on the review screen, an "Update album" button re-lays out the current album with the rule-based filler — keeps the AI's chapters, title and order where possible, removes dropped photos, adds newly kept ones to the right chapter by time. Free, unlimited, never counts as an AI rebuild, never runs on a user-edited album. AI rebuilds remain for re-planning the whole story. **Why:** with only 2 free rebuilds, review choices would otherwise never reach the album ("AI drafts, the user decides"). **Rejected:** re-flowing on every tap (layout jumps while deciding); leaving it to the M5 editor.

## D-029 — Caption Writer runs inside the AI run; no /api/ai/captions (2026-11-09)
**Decision:** Captions are written in the orchestrator's captioning state (advance ticks, D-022/D-025), batched by consecutive moments up to 12 captionable pages per call (≤ ~10 calls per book), only for layouts with a caption area. `/api/ai/captions` is dropped; per-caption rewrite stays M5 `/api/ai/rewrite`. **Why:** consistent with resumable ticks; bounded calls. **Rejected:** one call per moment (up to 100 calls).

## D-030 — Deterministic caption pre-check + Critic with one targeted repair round (2026-11-09)
**Decision:** Every caption passes a code pre-check (≤ 18 words, language/script, no URLs/attribution, capitalised names/places and digits must exist in metadata, no duplicates). The Critic scores the book; repair re-calls only the Caption Writer for affected pages (pre-check failures always; Critic issues when score < 7), cover swaps are done in code, one round only; captions still failing become null. **Rejected:** Storyteller re-call during repair (slow, discards captions).

## D-031 — User captions block AI rewrites, not Update album (2026-11-09)
**Decision:** A doc containing any `caption.source = 'user'` is never overwritten by an AI run (409 user_edited), but the free Update album (D-028) still works and keeps user captions; re-fitted/new pages get `caption: null` (filled later by the M5 ✨ rewrite). Caption Writer headings replace Storyteller chapter titles unless they fail validation. Rule albums get no captions in M4.

## D-032 — Memory Keeper is code-only in M4, triggered by review Continue (2026-11-09)
**Decision:** `deriveMemoryUpdate` learns tone (only when it differs from the occasion default), caption language, and caption length (from ≥ 3 of the user's own captions); runs on review "Continue" (later also M5 editor exit and M6 publish). No AI summary until M5 has real edit diffs. Memory is injected into the Storyteller / Caption Writer user message (never the cached system prompt), framed as data. New books prefill tone + language from memory. /settings shows and clears it.

## D-033 — agent_runs.cursor limit raised to 256 KB (2026-11-09)
**Decision:** Migration 0800 raises the cursor size check to 262144 bytes so captions can live in the cursor between ticks (stripped at finish). **Rejected:** storing caption text in agent_steps (breaks D-027).

## D-034 — Build captions have internal caps, separate from rewrite limits (2026-11-09)
**Decision:** `maxCaptionBatchesPerBuild` 10 + one repair per batch in limits.ts; build captions don't count toward the CLAUDE.md caption-rewrite limits (20 free / 200 paid), which apply to the M5 Rewriter.

## D-035 — Per-run AI spending cap (2026-11-09)
**Decision:** `maxRunCostUsd` in limits.ts — free $1.50, paid $6.00 — checked before every Caption Writer, Critic and repair call (run total from agent_steps). Over the cap → finish with captions so far, run ai_status partial (error_code run_budget). Caption repairs use effort `low` (CLAUDE.md: rewrites low). Critic is skipped when the book has no AI captions. **Why:** worst-case caption+critic+repair spend was ~$4.6 per paid build with no dollar ceiling. Verify real costs in M4b and tune.

## D-036 — books.doc / page_count / doc_rev are server-only; optimistic concurrency via doc_rev (2026-11-09)
**Decision:** Migration 0900 extends `protect_book_columns` so non-service roles cannot change `doc`, `page_count`, `doc_rev` (extends D-011). Editor saves go through `PUT /api/books/[id]/doc`, which re-validates the whole doc (photo ownership, max_pages from DB, fonts) and writes with the admin client `WHERE doc_rev = baseRev` (409 on mismatch, no merge). Server forces `meta.userEdited = true`. AI writers keep the `updated_at` lock + `isAiReplaceableDoc`. **Why:** authenticated users could bypass validation and the 20-page free limit via PostgREST.

## D-037 — Editor product rules (M5) (2026-11-09)
**Decision:** (1) An accepted ✨ rewrite gets source `user`. (2) After an editor save, Update album / Rebuild with AI stay disabled; merge-aware rebuild deferred (replaces D-018's "until M5" note). (3) "Upgrade" before M7 = "Coming soon" sheet. (4) Placing an AI-dropped photo marks it kept (`user_override`). (5) Dragged page takes the previous page's chapter; "Move to chapter" appends; empty chapters pruned. (6) Only successful rewrites count toward the rewrite limit; max 1 in flight per book; rewrite runs are excluded from the one-active-run-per-book index. (7) Cover title edit also updates `books.title` (≤ 120 chars). (8) Rewriter gets the page's photo notes as text (no images). (9) Low-res warning below 150 dpi effective at A5, never blocks.

## D-038 — Rewrite runs are isolated from builds; daily rewrite ceiling (2026-11-10)
**Decision:** Rewrite runs use their own state `rewriting` (never `queued`), are excluded from claim_agent_run and every build-run lookup (BUILD_RUN_TRIGGERS), and the create RPC fails this book's rewrites older than 5 min. Besides the per-book cap (20 free / 200 paid, ok runs only), a per-user ceiling of 60 (free) / 400 (paid) rewrite runs per rolling 24 h counts all outcomes; tier = the book being edited (one paid book lifts the user to 400/day — accepted). **Why:** reviewer B1 (a queued rewrite row could be advanced as an uncapped full build; crashed rewrites froze review) and S1 (failed rewrites were free and billable).

## D-039 — Publish = snapshot; free expiry fixed at first publish (2026-11-10)
**Decision:** Publish copies the saved doc into `books.published_doc` (+ published_rev, last_published_at); the viewer renders only the snapshot; editor shows "Publish changes" when doc_rev > published_rev. `expires_at` = first publish + 30 days for unpaid books, never extended by republish/unpublish; paid (webhook-set is_paid) never expires. Slug `{ascii-title ≤30}-{10 base58}` (random only for Arabic/empty titles), never changes. Expired free books stay editable, republish blocked ("Upgrade to bring it back"). **Why:** autosave would leak half-finished edits to shared links; republishing must not make free links permanent (D-002).

## D-040 — Viewer product rules (M6) (2026-11-10)
**Decision:** Chapter headings shown as a viewer label + Contents sheet (not on pages; BookPage/PDF unchanged). Free: watermark + sticky "Made with Photobook — create yours" footer + end card; paid: only a small end-card link. Optional password (free + paid, 4–64 chars, scrypt, HMAC access cookie, rate-limited unlock); password books' OG/meta show no title/cover. LTR page order for all books in v1 (RTL books M10+). Single page on phones, spread ≥ 768 px. Editor Done → /books/[id]/publish. APP_NAME placeholder "Photobook" (one constant). If react-pageflip fails on React 19, wrap vanilla page-flip instead (log decision).

## D-041 — Public viewer images use signed URLs that reveal the storage path (accepted for v1) (2026-11-10)
**Decision:** The viewer and OG image use 6 h Supabase signed URLs for `web` copies only. Their path contains the owner's user UUID and book id. Accepted for v1: UUIDs aren't credentials, RLS/storage policies are owner-only, and each URL unlocks one EXIF-free web file. Cost: two links from the same owner can be linked to each other. **Rejected for now:** an image proxy route (doubles egress through Vercel functions) or copying images to opaque `published/` paths at publish (storage + cleanup complexity). **Revisit:** before public launch (M9/M10) if privacy review or the reviewer asks; the proxy is the simpler fix.

## D-042 — Password unlock limits count failures only (2026-11-10)
**Decision:** A successful unlock deletes its own attempt row (`clear_unlock_attempt`, migration 1100, service_role only), so limits count failures: IP bucket 10 per 15 min, book 30 failures per hour. IPv6 is bucketed to its /64 (IPv4-mapped → IPv4) before hashing; malformed XFF → shared "unknown" bucket. Unknown / not-password books answer wrong_password at once without scrypt (they already 404 / show no gate, so no new oracle). **Why:** wedding/family groups on one CGNAT/Wi-Fi were burning the book limit with correct passwords; per-address IPv6 made the IP limit trivial to dodge. **Accepted tradeoff:** a few IPs can lock a password book for ≤ 1 h for people without the 30-day access cookie. **Rejected:** counting all attempts (blocks legit groups); CAPTCHA (friction on WhatsApp-arrival phones, extra vendor).

## D-043 — Viewer reads only the published snapshot (2026-11-10)
**Decision:** /b/[slug], OG image and share title use only `published_doc`: title = snapshot cover title || APP_NAME; caption language frozen into the snapshot as optional `captionLang` (live `caption_lang` only as fallback for pre-fix snapshots). "Published" in dashboard/editor = live `published_doc` exists, not `published_rev`. **Why:** extends D-039 — unpublished edits (title, language) must never leak to viewers; published_rev survives unpublish. **Rejected:** reading live `books.title` (leak), a separate published_title column (one more thing to keep in sync).

## D-044 — Paid entitlement is read live; content from the snapshot (2026-11-10)
**Decision:** Watermark, footer, expiry, page cap and AI limits follow live `books.is_paid` / `max_pages` / `expires_at`; the published snapshot only supplies content. A webhook payment takes effect on the next page load with no republish. **Why:** extends D-039/D-043 — entitlement is not content. **Rejected:** writing is_paid into the snapshot (needs republish; races with webhook).

## D-045 — Payments: webhook-only fulfilment, refunds never revoke, inline price (2026-11-10)
**Decision:** Only the Stripe webhook marks a book paid (fulfill_book_checkout, service_role, deduped by event id in the same transaction); the success page only polls. Price is inline `price_data` from src/lib/pricing.ts (3900 fils AED), adaptive pricing off; a converted session is accepted only if its source is AED 3900. Refunds/disputes update the order only — is_paid is never revoked automatically (manual via Stripe Dashboard / SQL). Paid-but-invalid sessions → order `needs_review` + error log, checkout blocked for that book. Double payments are logged (`double_payment`), refunded by hand. Entry points: publish, editor Upgrade sheet, owner expired page — not the public viewer or dashboard. Customer email prefilled; no Stripe Customer objects. Production refuses test keys unless STRIPE_ALLOW_TEST_IN_PROD=1; a live event under a test key → 503 (Stripe retries), a test event under a live key → 200 ignored. **Rejected:** fulfilling from success_url (violates locked rule), Stripe Price ids in env (label/charge/check could drift), auto-refunds/auto-revoke (v1 volume too low to justify).

## D-046 — AED 39 is VAT-inclusive; no Stripe Tax in v1 (2026-11-10)
**Decision:** Charge a flat AED 39, no tax line. **Why:** UAE VAT registration is mandatory only above AED 375k/yr taxable supplies; VAT can't be charged before registering. **Open:** user to confirm with an accountant; revisit at registration (Stripe Tax + automatic_tax).

## D-047 — PDF renders the saved doc, snapshotted per export (2026-11-10)
**Decision:** The PDF uses books.doc (latest saved edits), not published_doc; publishing isn't required. Each export row snapshots doc, doc_rev, caption_lang. Paid status read live. **Why:** PDF goes only to the owner (D-039/D-043 protect viewers, not owners). **Rejected:** published snapshot (owner would miss edits).

## D-048 — Print route only via short-lived HMAC token in a header (2026-11-10)
**Decision:** /print/[bookId] renders only with a 5-min token (key HMAC(BOOK_ACCESS_SECRET,"print-token-v1")) bound to export, book, doc_rev and sheet range, sent as `x-print-token` on same-origin navigation (query token only outside production); export must be 'rendering'; everything else 404; noindex/no-store/no-referrer; robots disallow. **Rejected:** session cookies in Puppeteer, long-lived tokens, token in URL (logs).

## D-049 — Print images made in memory, never stored (2026-11-10)
**Decision:** sharp copies per export: rotate, strip EXIF/GPS, sRGB, baseline JPEG q80 quantisationTable 3, sized for 300 dpi incl. bleed × zoom, ≤ original, ≤ 3000 px; served via request interception on https://print-assets.invalid; all other external requests blocked. Prefetch 2 chunks ahead, 8–12 downloads in flight, encodes per vCPU. **Rejected:** stored print derivatives (column + cleanup + backfill), mozjpeg (3–11× slower for ~15% smaller files).

## D-050 — Bleed: 3 mm all sides, 154×216 mm sheets (2026-11-10)
**Decision:** Print sheets 154×216 mm; edge slots extend 3 mm; text ≥ 4 mm inside trim (tested over all layouts); TrimBox/BleedBox set from Chromium's real MediaBox top-left; cover + pages, no back cover; never a watermark; static OFL fonts for print (Chromium turns variable fonts into Type3).

## D-051 — Export jobs: async, reused, capped, never deleted (2026-11-10)
**Decision:** POST → exports row → after() render; client polls a light status route; reuse ready PDF for same doc_rev + caption_lang + renderer_version; 1 in flight per book; 20 rows/user/rolling 24 h (older PDFs superseded — rows kept so the cap holds); 10-min signed URL; keep only latest PDF object per book; 1 render per instance under Fluid compute.

## D-052 — Chromium on Vercel, chunked (2026-11-10)
**Decision:** puppeteer-core 25.11.0 + @sparticuz/chromium 153 (function ~94 MB), 20-sheet chunks merged with pdf-lib, `__PRINT_READY__` after img.decode + fonts.ready, deadline = maxDuration − 30 s with real abort. Fallback if Vercel limits bite: same renderer on AWS Lambda (me-central-1).

## D-053 — Stay on Vercel (Hobby for now) + Supabase; no AWS/MySQL move (2026-11-10)
**Decision:** Keep Vercel + Supabase Postgres. Hobby now (Fluid compute, maxDuration 300 s, 2 GB/1 vCPU — sizing adapts by memory); PDF_MAX_DURATION_SECONDS is the single switch. **Why:** MySQL would mean rewriting RLS, ~15 PL/pgSQL RPCs, auth and storage for no user gain; full AWS saves ~$10–25/mo at launch scale for weeks of migration + ops. **Must:** upgrade to Vercel Pro before real payments (Hobby is non-commercial). **Revisit:** if Supabase costs grow → RDS Postgres (never MySQL); if PDF hits Hobby limits → Lambda worker or Pro.

## D-054 — Paid end card (2026-11-10)
**Decision:** Paid flipbooks end on a real page: book background, "The end", snapshot title (dir=auto), Replay + Share (text-only buttons ≥ 44 px), small "Made with" link. Free end card unchanged; phones never get a filler page. Supersedes D-040's "paid: only a small end-card link" (it read as a blank page on phones).

## D-055 — Retention (2026-11-10)
**Decision:** Free published books deleted at expires_at + 14 d (owner can still upgrade from the expired page); never-published drafts after 45 idle days (updated_at / newest photo) — only after a confirmed warning email ≥ 7 d earlier, or with no photos, or when the owner can't be emailed (reminders off → dashboard shows the date from day 38); paid/comped books and books with pending/paid/needs_review/disputed orders never auto-deleted; pending uploads + orphan storage objects 7 d; superseded/failed export rows 30 d (amends D-051 — cap counts 24 h only); unlock attempts 24 h; stale AI runs 1 h → failed. Numbers live in src/lib/cleanup/rules.ts (legal pages/FAQ import them). Opening a warned draft in the editor/review restarts its clock.

## D-056 — One daily cron (2026-11-10)
**Decision:** /api/cron/cleanup at 0 1 * * * UTC (Hobby: fires within the hour), Bearer CRON_SECRET (constant-time), 240 s budget, batched sweeps resumed next day, row-first then storage with an orphan sweep as safety net, count-only logs. Emergency stop = remove CRON_SECRET (route 503).

## D-057 — Email via Resend; crash-safe warnings (2026-11-10)
**Decision:** v1 emails: link expires in 3 days, draft deletion in 7 days; one-click unsubscribe (HMAC(BOOK_ACCESS_SECRET,"unsub-v1"), GET non-mutating) sets profiles.email_reminders=false. Claim → send → confirm (migration 1800): a warning counts as sent only after Resend accepts it; stale claims reclaimable after 1 h; warnings get a 100 s sub-budget. No key → nothing claimed. Supabase Auth SMTP via Resend before launch. Deploy order for 1800: code first, then migration the same day.

## D-058 — Privacy-first analytics and errors (2026-11-10)
**Decision:** PostHog EU, cookieless (memory persistence), lazy slim build, allow-listed events with numbers/booleans/enums only, sanitized URLs (/b/:slug, :id, no query); "Discard client IP data" on in PostHog. Sentry EU, no tracing/Replay, sendDefaultPii false, scrubbed events (query strings, slugs, ids, emails, tokens, caption-like keys, Postgres row text). Both no-op without keys. **Rejected:** cookie banner + persistent ids (friction for WhatsApp visitors, consent burden).

## D-059 — AI daily budget breaker (2026-11-10)
**Decision:** AI_DAILY_BUDGET_USD caps total live AI spend per Asia/Dubai day; at/over budget new builds, rebuilds and rewrites are refused before any run row or model call (rule-based album + "AI is taking a break — try again later"); 0 = kill switch; invalid value = unlimited; spend query errors fail open; ≤ 60 s per-process cache. Admin page /admin/ai-spend shows daily spend vs budget.

## D-060 — Delete book and delete account in v1 (2026-11-10)
**Decision:** Delete book (dashboard ⋯ menu) via delete_book_guarded RPC — refused if paid/comped or an order is pending/paid/needs_review/disputed ("contact support"). Delete account (Settings, type DELETE) deletes ALL the user's books incl. paid/comped (orders kept with nulls for accounting), storage, then the auth user; refused while an order is pending ("payment in progress") or disputed/needs_review ("being reviewed"). **Why:** UAE PDPL / GDPR rights promised in the privacy policy.

## D-061 — Comped demo books (approved exception to webhook-only is_paid) (2026-11-10)
**Decision:** Admin-only `comp_book` RPC (service_role) via scripts/comp-book.mjs (--admin must be in ADMIN_USER_IDS) marks a book paid and records an AED 0 'comped' order (note + comped_by) as an audit trail. Used for landing-page demo books (scripts/seed-demo-books.mjs comps first, then builds). Customer books still become paid only through the Stripe webhook. Reverting a comp is a manual RUNBOOK step. **User approved (b) on 2026-11-10.**

## D-062 — Book doc v2, backgrounds, print rules (2026-11-10)
**Decision:** Doc v2 adds format (A5 portrait | A5 landscape), style.background (colour | texture{id,tint?} | photo{id, veil 0.5–0.9, veilColor}), designStyle, page.background (+ source ai|user), page.side, ≤ 12 slots. parseBookDoc upgrades v1 on read; serializeDoc writes v1 whenever no v2 feature is used (existing books byte-identical; M9 rollback safe for them — v2 books (textures/photo backgrounds/landscape) show "invalid/unavailable" on M9 and must not be rolled back past). Text ink: catalogue swatches use declared ink, other hex keep M9 dark (colorInk). Print: CSS `filter` banned (rasterises photos + text); shadows via box-shadow; textures via background-repeat (embedded once). "Whole book" background clears page overrides (one undo step + toast). **Privacy:** a user may pick any ready photo of the book (kept or AI-dropped) as a background; it then becomes public on publish and appears in the PDF — acceptable because only an explicit user pick can do it; AI background suggestions (M10c) must use kept photos only.

## D-063 — Book format + design style are fixed at creation (2026-11-11)
Decision: format (A5 portrait/landscape) and design style are chosen on the New book form, stored in books.format / books.design_style (migration 1900, insert-only for users), and are the server's authority for doc.format / doc.style.designStyle; the editor shows them read-only. User-approved.
Why: changing shape/style needs a full relayout; Restyle is deferred (user decision M10 planning).
Alternatives rejected: editable in editor (relayout every page, risk of losing user edits).

## D-064 — Spread reflow rule (2026-11-11)
Decision: a spread starts on a left page (even index, after the cover). It moves and deletes as one unit (delete asks to confirm, removes 2 pages). If a single-page add/delete pushes a later spread onto a right page, it splits into its single-page twin layouts, keeping all photos and user captions, with an Undo toast. Never insert blank filler pages. User-approved.
Why: keeps limits honest (spread = 2 pages), no empty pages, no blocked actions.
Alternatives rejected: insert blank page (wastes 20/100 limit), block the action (frustrating).

## D-065 — M10b style + font scope (2026-11-11)
Decision: New book form offers Modern (default for every occasion via DEFAULT_STYLE_BY_OCCASION) and Classic; Geometric/Scrapbook arrive in M10c. New OFL fonts offered as caption font pairs (Cormorant+Amiri, Bebas Neue+Lalezar, Great Vibes+Aref Ruqaa); any new font name is a v2 feature. M10a fonts/textures signed off "as is" by the user.

## D-066 — Deleting a photo reflows its page (2026-11-11)
- Decision: deleting a photo that is in the album refits that page/spread to a smaller layout of the same style (no empty slot), also in user-edited albums. AI captions on the refitted page go (D-031); user captions are never lost. A chapter whose last page empties is removed (as D-028 rule 4) — except in a user-edited album, where the delete falls back to the M10a empty-slot null-out so a user-typed chapter title is never lost. Any guard failure (caption loss, validation, page growth, unsupported style) → empty-slot fallback.
- Why: empty slots after a delete looked broken (A19 S2); chapters carry no source field, so a user-renamed title can't be told apart from an AI one.
- Alternatives rejected: always null-out (empty gaps); always drop empty chapters (loses user titles).

## D-067 — M11 App UX polish before M10c; app look matches the book styles (2026-11-11)
- Decision: app screens adopt the book look (warm paper palette, Playfair Display headings — already loaded, 0 extra bytes — Inter/Cairo body, 44 px buttons, shared PageHeader/StepProgress/Notice/EmptyState/Loading/Toast). Scope = visual polish + key flow fixes (review hierarchy, docked editor pickers, WhatsApp-first publish, real-stage build checklist). Dashboard cards show real cover photos (read-only backend change, no migration). Email + Sign out move into an account menu. Style board signed off by the user before pages change. App chrome only: BookPage/print/layouts and --foreground/--font-sans untouched (goldens + print pixel baseline unchanged).
- Why: user asked for "every page more user-friendly, classic and modern"; chose all recommended options 2026-11-11.
- Alternatives rejected: Cormorant app-wide (60–100 KB on every page); new brand direction; visual-only or full onboarding rework; M10c first.

## D-068 — M10c scope + defaults (2026-11-11)
- Decision: 34 new layouts (geometric 6 pages + 1 spread + 1 cover, scrapbook 6 + 2 + 1, per orientation). Occasion defaults (replaces D-065's all-Modern): wedding Modern, travel Geometric, graduation Geometric, baby Scrapbook, family Scrapbook, other Modern. AI background suggestions for Geometric, Scrapbook and Modern; Classic stays white (Classic docs v1 + prompt prefix byte-identical). Stickers: original neutral set + one accent per occasion + Eid/Ramadan motifs (crescent & star, lantern). No new fonts. Faded-photo backgrounds Scrapbook only, ≤1 per chapter on its first page, kept photos only. Book-level `style.backgroundSource: ai|user` (doc JSON, v2-only when present, stripped from published doc); AI writes book background only when absent/ai. No migration. Restyle stays out (D-063).
- Why: user chose all recommended options 2026-11-11.
- Alternatives rejected: Modern default everywhere; AI backgrounds for new styles only / all four; neutral-only stickers; handwriting font; faded photos in every style.

## D-069 — M12 Reliability scope (2026-11-12)
- Decision: one deadline fetch (src/lib/supabase/deadline.ts) for all Supabase clients with per-class budgets; timeouts return a synthetic 504 `SUPABASE_TIMEOUT` so existing error paths carry it; routes map it to 503 + Retry-After; getCurrentUser throws SupabaseUnavailableError on auth timeouts (no false sign-outs); saveDocIfRev treats an identical replay as success; AI LEASE_MARGIN_MS 20→30 s. Small fixes: sliced-cover "Add photo", picker memo, PDF ref walk. Emoji in PDF captions deferred to after launch (user choice).
- Why: Bug 2 (intermittent hung Supabase fetches); user chose reliability before launch.
- Alternatives rejected: Postgres statement_timeout (needs migration, later); XHR progress-based stall detection (out of scope).

## D-070 — M13 easiest flow: photos first, shape/style lock at first AI build, auto-build, review folded, Share = publish (2026-11-12)
- Decision: (1) D-063 amended: page shape and style are editable on the setup card until the first AI build starts (no run yet, album not user-edited), then fixed. (2) The first AI build starts automatically when the first upload settles (≥5 ready photos, no prior run, normal caps D-021/026/035/059; never an automatic rebuild). (3) Build goes straight to the editor; review is reached from an "AI kept X of Y" chip (AI choices stay visible + editable, D-031/D-037 logic unchanged). (4) Editor "Share" publishes + opens the share screen (30-day free notice on the button); WhatsApp stays a separate tap. (5) Guest mode deferred to M13b after measuring login drop-off.
- Why: user asked for the easiest flow vs competitors; chose all recommended options 2026-11-12.
- Alternatives rejected: style-first screen; review before editor; Done then Publish; guest mode now.

## D-070a — setup details also lock on user-edited albums (2026-11-12)
- Decision: occasion, feel, caption language and title (not only shape/style) lock once the album is user-edited or an AI run exists, so a user's cover title always wins (D-037 #7). Residual race (run created between the last run check and the setup UPDATE) documented; closing it needs an atomic RPC in a future migration.
- Why: M13 review NIT; avoids books.title drifting from a user-edited cover.
