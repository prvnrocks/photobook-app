# Progress (newest at the bottom)

Format: `## YYYY-MM-DD — Milestone N — status` then 3–6 bullets: what was built, what's tested, what's left.

## 2026-11-03 — Planning — done
- Product decisions locked (see CLAUDE.md). Plan written in docs/PLAN.md, AI agent design in docs/AI-AGENTS.md.
- Agentic OS set up: hooks log every step to .agentos/logs/, memory in .agentos/memory/, subagents in .claude/agents/.
- NEXT: Milestone 0 (project skeleton). Prerequisites in docs/PLAN.md → "Before you start".

## 2026-11-03 — Milestone 0 — built, awaiting deploy (NEEDS-HUMAN)
- Next.js 15.5.29 + TS + Tailwind v4 + shadcn/ui (v4, base-ui) + ESLint 9 + Vitest 5 + Playwright; Node >=22 required.
- Supabase helpers in src/lib/supabase/ (client, server, admin [server-only], env); PLAN folder tree as .gitkeep/stubs; .env.example (9 keys).
- Landing at src/app/(marketing)/page.tsx: Inter + Cairo + Tajawal, Arabic caption with dir="auto", no overflow at 375px; builds with no env vars.
- Tests: 12 Vitest (cn, .env.example keys, server-only/secret boundaries) + 4 Playwright at 375px — all pass. Reviewer approved, no blockers. Run report: .agentos/runs/m0.md.
- LEFT: user pushes to GitHub, imports into Vercel (Node 22.x/24.x), checks landing on phone → then tick the deploy checkbox in PLAN.md.
- NEXT: Milestone 1 (DB + login). Needs Supabase project + .env.local keys. Carry over reviewer's M1 notes (middleware getUser + two-arg setAll, Database types).

## 2026-11-03 — Milestone 0 — done
- Pushed to github.com/prvnrocks/photobook-app (main). Vercel auto-deploys main; production URL https://photobook-app-alpha.vercel.app/ (public).
- User confirmed on phone: no sideways scroll, Arabic caption RTL in Cairo, button disabled.
- Vercel deployment-hash URLs (*-prvnrocks-projects.vercel.app) are behind Vercel Authentication — share only the production domain.
- NEXT: Milestone 1 (DB + login). User must create Supabase project (eu-central-1 or ap-south-1) and fill .env.local + Vercel env vars.

## 2026-11-08 — Milestone 1 — done
- DB live on hosted Supabase (3 migrations): profiles/books/photos/orders, owner-only RLS, protected book columns (D-011), get_published_book, private photos/exports buckets with `{user_id}/{book_id}/...` paths, hardening (explicit grants, anon none). Live rls_check.sql: 31/31 OK.
- Auth: email link via /auth/confirm (token_hash) + 6-digit code + Google (D-010); middleware session refresh; /login, /dashboard (My books + empty state), /books/new placeholder, sign out. Keys = publishable/secret (D-009).
- Tests: 144 Vitest + 14 Playwright @375px; no secret in client bundle. Reviewer approved; should-fixes applied.
- User confirmed on phone: email link → dashboard, Google → dashboard; 1 user + 1 profile (name null — email signup has no name; header shows email).
- LEFT/CARRY: 6-digit code path not yet tried on phone; custom SMTP (Resend) before real users (built-in ~2 emails/h, team members only); storage cleanup on user delete; Google consent screen "Publish app" before launch; HEIC originals vs PDF (M2).
- NEXT: Milestone 2 (upload + metadata). Needs MAPBOX_TOKEN.

## 2026-11-08 — Milestone 2 — done (place names: open question)
- Upload pipeline live: /books/new (occasion/tone/EN-AR/title) → /books/[id]/upload (one photo at a time, resumable by fingerprint, wake lock, 150/500 cap) → finalize (dup groups, 1 km GPS clusters → Mapbox v6 permanent, fallback album only when doc = {}). 5 migrations applied; live rls_check 61/61.
- Client: EXIF before HEIC, filename/lastModified date fallback, original/web/thumb (HEIC → JPEG), dHash + blur, header size pre-check (>100 MP rejected, >16 MP reduced decode).
- Tests: 587 Vitest + 20 signed-out e2e + 5 live signed-in e2e (upload, resume, cap, guards, finalize 429). Reviewer approved; S1–S8 fixed.
- Phone acceptance (user, iPhone): 110 photos all ready with date (exif), size, hash, blur, 330 files; 17 dup groups (48 photos); album 20 pages. **0 photos had GPS** → place names not exercised on a real phone (pipeline verified with fixtures in e2e). Likely iOS photo picker strips location (or photos had none) — user didn't confirm.
- CARRY to M3: confirm iOS location behaviour; if stripped, add an upload hint ("Options → Location") and make Storyteller work without places; 44% of photos in dup groups looks high — tune thresholds with real photos (Curator decides anyway); decide doc origin marker (rule vs AI) before M3 (reviewer N2, changes D-016 — ask user); add `ai_status 'partial'` if AI-AGENTS.md needs it; AI usage counters server-side only.
- NEXT: Milestone 3 (AI agent pipeline). Needs ANTHROPIC_API_KEY in .env.local + Vercel (Sensitive).

## 2026-11-09 — Milestone 3a — done (replay); M3b waiting for ANTHROPIC_API_KEY
- AI pipeline live in code, OFF in production (no key → rule album + "AI isn't switched on yet"). Migrations 0600 + 0700 applied; live rls_check 80/80.
- Built: Claude client (claude-opus-5-5, effort low/medium, structured outputs via lenient parse, fallbacks "default", prompt caching, maxRetries 0 + hard timeouts), off/replay/live modes (D-024), runAgentStep logging every call, Curator (10 thumbs, group-aware batches), Storyteller (validated plan, 1 retry, rule fallback), resumable orchestrator with lease tokens + capped run creation (3 free / 20 paid per day, rebuild caps), /books/[id]/build, /books/[id]/review (keep/drop, free Update album D-028, Rebuild with AI), /admin/runs/[id] (ADMIN_USER_IDS).
- Dup thresholds tuned on real phashes (D-019): user's book 17/48 → 10 groups / 23 photos (regrouped in prod).
- Tests: 1161 Vitest + signed-out e2e 31 + live replay e2e 7 (build, review, toggle, Update album, rebuild, refusal, off, userEdited). Reviewer approved; all pre-live blockers fixed.
- OPEN (human): phone check of review/Update album/rebuild in production; iPhone picker "Options → Location" hint wording (D-020); add ADMIN_USER_IDS (user's uid 3206858b-…) to Vercel Production+Preview.
- M3b CHECKLIST (when key arrives): add ANTHROPIC_API_KEY (Sensitive) to .env.local + Vercel; confirm Fluid compute; first live call works with beta parse + fallbacks (kill-switch USE_SERVER_FALLBACKS); cache_creation then cache_read > 0; real latency per batch / Storyteller vs timeouts (60/180 s) and lease 240 s; 150-photo book < 90 s?; cost per book vs ~$1/200 photos target; max_tokens hit rate; re-record replay fixtures (structure only); tune prompts; live daily/rebuild caps end to end; privacy policy mentions AI processing + admin trace access.
- NEXT after M3b (or in parallel): Milestone 4 (Caption Writer + Critic + user memory).

## 2026-11-09 — Milestone 4a — built + replay-tested; NOT yet deployed (waiting for migration 0800)
- Caption Writer (batches ≤ 12 captionable pages, ≤ 10/book; native Arabic; prompt v2 bans famous quotes/lyrics), deterministic caption pre-check (≤ 18 words, script, URLs/attribution, names/digits only from user title + GPS places + user-typed names + dates; holidays/family words/months allowlisted), Critic (v2; caption_not_original) + one targeted repair round (effort low), cover swap in code, per-run cost cap free $1.50 / paid $6 (D-035), cursor size guard.
- User memory: Memory Keeper (code-only) on review Continue; memory injected into Storyteller (v4, sentence-case titles) + Caption Writer user messages; /settings view + clear (also strips active runs' cursor.memory); new-book prefill. AI never overwrites user captions; Update album keeps them (D-031).
- Review: captions preview (dir=auto, lang=ar per caption, Cairo), honest banners (captions_missing; rule-fallback only when rule album used), stage copy "Writing captions…/Final check…/Polishing…".
- Tests: 1560 Vitest + signed-out e2e 32 + live replay e2e 15/15 (English, Arabic, planted bad caption repaired, Critic-only refusal, memory round trip, Settings clear, Update album, user-caption guard, off mode). Reviewer approved; all SHOULD-FIX applied.
- BLOCKER FOR DEPLOY: user must apply migration 0800 (cursor 256 KB) + rls_check 82 BEFORE merging M4 to main (prod cursor limit is 64 KB; large paid books would fail).
- M4b (with M3b, live key): caption quality EN/AR (native reader), Critic catching real invented names / Arabic names / famous quotes, pre-check false-positive rate on real Eid/Ramadan albums, real cost per batch/critic/repair vs D-035 caps, cache hits on caption_writer/critic prompts, captioning stage visible, pg_column_size of a large paid cursor.
- Backlog: stale-run reaper (M9 cron); tonePreference never unlearned (M5); AI cover title not name-checked (user title wins when set); memory-clear race with a tick holding the lease.

## 2026-11-09 — Milestone 4a — deployed
- Migration 0800 applied to prod (all 8 migrations in sync); main = 73377b4, live on https://photobook-app-alpha.vercel.app.
- Prod probes OK (/settings protected, AI routes 401/403 signed-out, AI mode `off` without key).
- LEFT: phone check (Settings, new-book prefill, captions preview); M3b + M4b live validation once ANTHROPIC_API_KEY is set; ADMIN_USER_IDS in Vercel.
- NEXT: Milestone 5 (editor).

## 2026-11-10 — Milestone 5a — built, reviewed (deploy: code first, then migration 0900)
- Editor at /books/[id]/edit: swipe carousel + desktop strip, bottom toolbar tools (Replace / Layout / Crop / low-res badge, Caption + 4 fonts + align, Cover title/subtitle, Chapter title, ✨ AI menu, Pages sheet with dnd-kit + buttons, Add page, Page menu, Upgrade "coming soon"), undo/redo, autosave 2 s with Saved ✓ and 409 reload banner, Done (flush → memory learn → dashboard). Shared <BookPage>/<BookCover> renderer (edit/view/print).
- Server: migration 0900 (doc/page_count/doc_rev server-only, doc_rev optimistic concurrency, rewrite runs in own 'rewriting' state excluded from build machinery, create_rewrite_run_capped with per-book cap + per-user daily ceiling + stale reaping); PUT /api/books/[id]/doc full server validation; photo-urls refresh; POST /api/ai/rewrite (Rewriter agent, replay mode, D-030 pre-check). Review→editor, dashboard card routing, build loop wakes after phone sleep.
- Tests: lint/typecheck ✓, vitest 2111/2111, e2e/editor.spec.ts 45/45 at 375 px, live E2E_AUTH a/b ✓ (c/d need 0900), PGlite rls_check 93 ✓. Reviewer APPROVED after 1 BLOCKER (rewrite runs leaking into builds) fixed.
- LEFT: deploy code → user `npm run db:push` (0900) → rls_check 93 → regen types, drop getMyBook doc_rev fallback → run E2E_AUTH c/d/r. NEEDS-HUMAN: phone "Done when" check (swipe, pinch crop, touch drag reorder, iOS keyboard vs docked caption sheet). M5b with API key: ✨ latency ~1 s, Arabic translation quality, cost per rewrite.
- Backlog: EditorToast single API + dismissOnEdit default (N2), carousel guard on slot tap (N1), stale rewrite rows with null book_id → cron (N3), toolbar sideways scroll at 375 px, keepalive 64 KB for 100-page books (N5), tone unlearning, "confirmed" marker for dashboard routing.
- NEXT: Milestone 6 (publish + flipbook viewer + sharing).

## 2026-11-10 — Milestone 5a — deployed
- Code live (main), migration 0900 applied (rls_check 93). Live signed-in tests pass: save + rev/409, 21-page 422, column guard no-op, rewrite (replay), Done.
- LEFT: phone "Done when" check (NEEDS-HUMAN); M5b live ✨ with API key. NEXT: Milestone 6.

## 2026-11-10 — Milestone 6 — built, reviewed (re-review APPROVED); NOT deployed
- Publish (/books/[id]/publish; snapshot published_doc, slug, free 30-day expiry fixed at first publish, optional password with scrypt + HMAC cookie + rate-limited unlock), public /b/[slug] flipbook (react-pageflip 2.0.3, single page on phone / spread ≥768 px, counter, Contents sheet, fullscreen, share WhatsApp/copy/native, watermark + "Made with" footer + end card for free), expired/password/404 states, OG PNG via next/og, dashboard/editor publish chips. Run report: .agentos/runs/m6.md.
- Review fixes (T11, commits ff79a17 + 8259441): viewer title/caption language from snapshot only (B1); published = live snapshot exists; migration 1100 clear_unlock_attempt (only failures count, book limit 30/h, IPv6 /64); no scrypt on unknown book; password refused without BOOK_ACCESS_SECRET; OG cache 1 h; flipbook rotation leak fixed (detached nodes 14,140 → 0 over 20 toggles); React cache() shares one read between metadata + page.
- Tests: lint/typecheck ✓, vitest 2477/2477, e2e viewer+publish 22/22, live publish-auth 8 pass/1 skip (password test e needs BOOK_ACCESS_SECRET in .env.local; test g's new unpublish→Draft step not yet run live). PGlite: 11 migrations apply, rls_check 106/106 (harness in session scratchpad pg/ — not in repo).
- DEPLOY ORDER: set BOOK_ACCESS_SECRET in Vercel (Production + Preview) and .env.local → merge/deploy code → user runs `npx supabase db push` (1100; safe either order, unlock still works without it) → run rls_check on prod (106) → run live publish-auth incl. e + g.
- LEFT (NEEDS-HUMAN): "Done when" — WhatsApp preview + smooth flip on another phone; iPhone battery with idle pageflip rAF loop.
- Optional NICE: normalise IPv4 text before bucketing (unlock.ts ~688); drop unused `admin` param in getPublishedBookRow. NEXT: deploy M6, then Milestone 7 (Stripe).
- (2026-11-10 later) BOOK_ACCESS_SECRET added to .env.local (generated locally; Vercel still needs its own). Live publish-auth on a prod build vs live Supabase: 9/9 pass incl. e (password + rate limit) and g (unpublish). Waiting on user: Vercel env → approve merge/deploy.

## 2026-11-10 — Milestone 6 — deployed
- main = 86114f7 (merge of m6-publish-viewer), live on https://photobook-app-alpha.vercel.app. BOOK_ACCESS_SECRET set in Vercel (user). Migration 1100 present in prod (clear_unlock_attempt RPC answers).
- Prod probes OK: /b/<unknown> 404 + X-Robots-Tag noindex, dev-viewer/dev-publish 404, /books/<id>/publish → login, generic OG PNG 200.
- LEFT (NEEDS-HUMAN): rls_check.sql in Supabase SQL Editor → expect "RLS OK — all 106 checks passed"; "Done when" phone check (WhatsApp preview + flip on another phone; iPhone battery with idle flipbook). NEXT: Milestone 7 (Stripe).
- (2026-11-10) User ran rls_check on prod: "RLS OK — all 106 checks passed". Phone "Done when" check still pending. Starting Milestone 7.

## 2026-11-10 — Milestone 7 — built, reviewed (APPROVED); NOT deployed; migrations 1200 + 1300 live
- Stripe Checkout (stripe 23.1.0, API 2026-10-28.endive, inline price_data AED 3900 from src/lib/pricing.ts, adaptive_pricing off, 31-min expiry, idempotency key per minute + params hash, reuse open session >5 min left), webhook /api/stripe/webhook (raw body + signature, dedupe in private.stripe_events inside fulfill_book_checkout, needs_review for paid-but-invalid, double_payment / livemode guards, refunds+disputes recorded never revoke), upgrade buttons (publish, editor Upgrade sheet incl. page 21 + rewrites exhausted, owner expired page) + "Payment cancelled" notice, /books/[id]/upgrade/success polling (2 s, 60 s, processing/support/timeout states). Entitlement read live from books (watermark, expiry, limits) — no republish. Run report: .agentos/runs/m7.md.
- PGlite harness now committed: `npm run db:dry-run` (scripts/pglite). rls_check 121 (prod OK). Signed-event CLI: scripts/stripe-signed-event.mjs.
- Tests: lint/typecheck ✓, vitest 2737/2737, signed-out e2e 102 pass / 42 skip, publish+editor+viewer with dummy keys 70/70, live e2e/payments.spec.ts vs prod DB 7 pass / 1 skip (c0 by design).
- DEPLOY: code safe without keys (buttons "Payments unavailable"). Prod refuses sk_test keys unless STRIPE_ALLOW_TEST_IN_PROD=1.
- NEEDS-HUMAN (T10 = "Done when" with real Stripe): Stripe account (UAE entity for AED payouts) → test keys in .env.local + Vercel Preview → `brew install stripe/stripe-cli/stripe && stripe login` → local `stripe listen --forward-to localhost:3000/api/stripe/webhook` + card 4242 → Dashboard webhook endpoint for Preview (events: checkout.session.completed, async_payment_succeeded, async_payment_failed, expired, charge.refunded, charge.dispute.created) → enable Apple Pay / Google Pay → pay on a phone; confirm a non-AED card session object. VAT question to an accountant (D-046).
- Backlog: double-payment check should include needs_review orders (needs migration); support runbook (admin exit from needs_review; paid-but-invalid with no order row only logs); add support email to brand.ts; getUpgradeTarget could return `live`. NEXT: deploy M7, T10 real test payment, then Milestone 8 (PDF).

## 2026-11-10 — Milestone 7 — deployed (payments dormant until Stripe keys)
- main = 5e7f181 live on https://photobook-app-alpha.vercel.app; migrations 1200 + 1300 in prod (rls_check 121).
- Prod probes OK: webhook POST 503 payments_unavailable (no keys), GET 405; /books/<id>/upgrade/success → login; /dev-upgrade 404; /api/stripe/checkout 404.
- LEFT (NEEDS-HUMAN): Stripe account + test keys on Vercel Preview → real test payment (T10, the "Done when"); VAT check; M6 phone check. NEXT: Milestone 8 (PDF).

## 2026-11-10 — Milestone 8 — built, reviewed (APPROVED); NOT deployed; migrations 1400 + 1500 live (rls_check 146)
- PDF export for paid books: POST /api/books/[id]/pdf → exports job (snapshot of saved doc, renderer_version 2) → after() runExport: print-size images (sharp, 300 dpi, EXIF stripped, prefetched 2 chunks ahead) served via Puppeteer interception on https://print-assets.invalid → /print/[bookId] (x-print-token header, 5-min HMAC) with 154×216 mm bleed sheets + static OFL fonts (no Type3) → 20-sheet chunks merged with pdf-lib (Trim/Bleed boxes) → exports bucket → 10-min signed URL. Light status route /api/books/[id]/pdf/status; Download PDF in publish screen + editor tool; free → upgrade. Run report: .agentos/runs/m8.md.
- Guards: 20 exports/user/24 h (rows superseded, never deleted), 1 in flight per book, 1 render per instance (Fluid), deadline 270 s with real abort, 30 s download timeout, size fallback 250 dpi q70 once, reuse same doc_rev + caption_lang + renderer_version.
- Tests: lint/typecheck ✓, vitest 3236 + 6 skipped, db:dry-run 146, signed-out e2e 106 ✓, live e2e/pdf.spec.ts 7/7 (15.8 s click→download locally). Tools: scripts/pdf-inspect.mjs, PDF_CHROME_PATH in .env.local.
- Decisions: stay on Vercel Hobby + Supabase for now (D-053); AWS Lambda PDF worker is the fallback if Hobby limits bite.
- DEPLOY (NEEDS-HUMAN): merge → confirm Fluid compute ON + PDF function max duration 300 s in Vercel → set function region near Supabase → phone test: paid 40-page book PDF on production (check timing log `[pdf-export] timing`). Pro before real payments (Hobby non-commercial).
- Backlog: orphan export PDFs on book/user delete (M9 cron: exports bucket {user}/{book}/*; delete superseded/failed rows after 30 d); emoji in captions render as boxes in PDF; 100-page noisy books may hit 50 MB even after fallback. NEXT: deploy M8, then Milestone 9 (clean-up, polish, launch).

## 2026-11-10 — Milestone 8 — deployed
- main = 952b737 live; Vercel accepted vercel.json (fluid + maxDuration 300) on Hobby. Prod probes OK: status route 401 anon, POST /pdf 403 cross-origin / 401 anon, /print 404 (no/garbage token) with noindex + no-store, robots Disallow /print/, /dev-print 404.
- LEFT (NEEDS-HUMAN): phone test of a real paid 40-page PDF on production (timing on Hobby 1 vCPU; read `[pdf-export] timing` in Vercel logs), function region near Supabase, Pro before real payments; M7 real Stripe test payment; M6 phone check; VAT. NEXT: Milestone 9.
- (2026-11-10) Test: user's book 'Myra Birthday' (d0401435…) marked paid via service role for M8 phone test (no order row). Revert: is_paid=false, max_pages=20, expires_at=<30 d from publish>.
- (2026-11-10) Reverted 'Myra Birthday' to free (is_paid=false, max_pages=20, expires_at=2026-12-10T09:20:28Z). No PDF export was created. User reported 'empty white screen in the last' on the paid viewer → M9 bug to investigate (likely paid end card / odd-page spread filler).

## 2026-11-10 — Milestone 9 — built, reviewed (APPROVED), launch smoke PASS; NOT deployed; migrations 1600–1800 live
- Paid end card ("The end" + title + Replay/Share) fixes the "blank last page"; daily cron /api/cron/cleanup (retention D-055: free books expiry + 14 d, drafts 45 d idle after a confirmed warning, orphans/pending 7 d, exports 30 d, stale runs); Resend warning emails (claim → send → confirm, one-click unsubscribe); delete book (dashboard ⋯) + delete account (Settings) + reminders toggle + deletion chips; payments hardening (comped books D-061, delete_book_guarded, double-payment flags); AI daily budget + /admin/ai-spend; landing page + draft privacy/terms; Sentry + PostHog (privacy-first); demo seed/record scripts; docs/LAUNCH.md + docs/RUNBOOK.md. Run report: .agentos/runs/m9.md.
- Tests: lint/typecheck ✓, vitest 3754, db:dry-run 173, launch-smoke 7/7 live, launch-checks 8/8, live delete/payments/pdf/publish ✓.
- DEPLOY: merge → deploy code → (1800 already applied — fine) → run rls_check on prod expecting 173 → check first cron run + `[email] warnings` without legacy=1.
- NEEDS-HUMAN before launch (docs/LAUNCH.md): Vercel Pro + Supabase Pro; domain; Resend domain DNS + Supabase Auth SMTP; PostHog EU ("Discard client IP"), Sentry EU keys; CRON_SECRET + AI_DAILY_BUDGET_USD in Vercel; SUPPORT_EMAIL + LEGAL_ENTITY_NAME + legal placeholders + lawyer review (LEGAL_DRAFT); MAPBOX_TOKEN invalid (401) — replace; demo books (seed script) + demo video (brew install ffmpeg); Stripe live + VAT; open phone checks M6–M9.
- Follow-ups: stale e2e/ai-auth.spec.ts h/f/m (M5 edited-album UI); cleanup log codes on auth failure; collapse zero days on /admin/ai-spend; touchWarnedDraft also on claimed_at; N2 comped_by visible to owner; N5 orphan sweep keyset at scale; N6 Sentry bundle on /b/. NEXT: deploy M9, then launch checklist; M10 (print, story mode) after launch.

## 2026-11-10 — Milestone 9 — deployed
- main = e7cf172 live. Prod probes OK: landing (hero claim) / privacy / terms / sitemap (only /, /privacy, /terms) 200; /admin/ai-spend, /dev-print, /dev-upgrade 404; /settings → login; unsubscribe bad token 400; /api/cron/cleanup 503 (CRON_SECRET not set → cron inactive, by design until set).
- LEFT (NEEDS-HUMAN): rls_check on prod → 173; set CRON_SECRET (+ AI_DAILY_BUDGET_USD) in Vercel Production and redeploy → check first cron log + `[email] warnings` (no legacy=1); everything in docs/LAUNCH.md; MAPBOX_TOKEN invalid. NEXT: launch checklist, then M10.
- (2026-11-10) Prod rls_check 173 OK (user) after M9 deploy.

## 2026-11-10 — Milestone 10a — built, reviewed (APPROVED), live-tested; NOT deployed (no migration)
- Doc v2 (format portrait|landscape, Background union colour/texture/photo, designStyle, page background + source, side, ≤ 12 slots); upgrade on read, serializeDoc writes v1 when no v2 feature (existing books byte-identical; M9 rollback safe for them). Golden freeze of M9 rendering (764 cases) stays byte-identical.
- Landscape geometry everywhere (lib + components + PDF @page; Chromium landscape 612×437.04 pt). Backgrounds: 16 swatches, 6 original CC0 textures (scripts/gen-textures.mjs), faded photo with veil; picker tool (This page / Whole book); rendered in editor, viewer, PDF (tile once per PDF, no CSS filter in print — guarded). Open-book editor ≥ 768 px, phone "View spread" sheet. CLAUDE.md formats line updated (user-approved).
- Tests: vitest 4014, e2e/m10a.spec.ts live 7/7, launch-smoke 7/7, editor 59/59, pdf 7/7. Run report .agentos/runs/m10.md.
- NEEDS-HUMAN: font + texture sign-off (docs/design/), phone check of facing pages/spread sheet/backgrounds; A7 font fallback chains on Linux sparticuz Chromium (check after deploy).
- Backlog: delete-photo strip should reflow pages (D-028) before any delete UI; published_doc keeps deleted photo refs until republish; picker polish (slider 60% display, keyboard commit, toast tracking, end-card ink parity). NEXT: deploy M10a (merge only), then M10b after design sign-off (migration 1900 first).

## 2026-11-11 — Milestone 10b — built + approved, awaiting deploy
- Landscape (classic 7, modern 16) + modern portrait (14) layouts, two-page spreads stored as page pairs (D-064), split-strip covers, text panels; 6 new OFL fonts; format + style on New book form (fixed after creation, D-063/D-065); Storyteller v5 per (format, style); migration 1900 applied (rls 175).
- Photo delete reflows the page (D-066), user captions + user-edited chapters never lost; review preview ignores spread right halves; unsupported_design for geometric/scrapbook until M10c.
- PDF: spread bleed, deep image dedupe, chunks ≤20 sheets/≤60 images (pairs whole), print-ready cap scales, spread cap 1.5×, PDF_RENDERER_VERSION 3.
- Tests: 5197 vitest, goldens, all live specs green; reviewer APPROVED. Runs: .agentos/runs/m10.md.
- Open risks: worst-case synthetic 100p panorama book too_large after fallback + ~2 GB local peak (real-photo check on prod); intermittent Supabase fetch hang (no deadline); Mapbox token/plan (NEEDS-HUMAN).
- NEXT: user "deploy" → merge to main; post-deploy real PDF check (Arabic + new fonts, Type0 only). Then M10c (geometric + scrapbook, shaped-slot crop, AI backgrounds).

## 2026-11-11 — Milestone 10b — deployed
- main fast-forwarded f1a5626 → d922e15 and pushed (via the resumed PDF builder at the user's request); prod alpha serves the new build (new texture asset 200). Migration 1900 was already remote; no db push.
- PDF_RENDERER_VERSION 3 → each paid book's next PDF re-renders once (counts toward the daily export cap).
- Post-deploy: real prod PDF check (Arabic + new fonts on Vercel Linux Chromium) — see runs/m10.md.

## 2026-11-11 — Milestone 11 (App UX polish) — built + approved, awaiting deploy
- App screens take the book look (D-067): paper palette, Playfair headings, 44 px buttons, shared PageHeader/StepProgress/Notice/EmptyState/Loading/Toast; account menu; loading skeletons + not-found/error pages.
- Flow fixes: New book grouped + truthful "fixed at creation" copy; upload drop zone; AI build checklist from real run states; review single "Continue to editor" hierarchy; editor docked Layout/Replace pickers + coach line; publish WhatsApp-first (green, user choice) + free vs upgraded card; PDF/payment states; viewer state screens; dashboard real cover thumbs.
- Gate PASS: 5347 vitest, goldens unchanged, book render parity 0 px (112 captures), e2e/m11 375 spec, all live specs; first-load JS ≤ +3 kB vs pre-M11. Reviewer APPROVED.
- NEXT: user "deploy" → merge m11-ux-polish to main (no migration). Then M10c.
