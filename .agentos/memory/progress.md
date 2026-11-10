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
