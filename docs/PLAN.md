# Build Plan — AI Photobook App (Claude Code, fastest path)

Goal: a live, paid digital product as fast as possible. Each milestone below = one Claude Code session,
run through the **Agentic OS** (see `.agentos/README.md`):
start each session with **`/build-milestone N`** — planner → builders → tester → reviewer → `/checkpoint`.
Use `/status` any time; `/clear` between milestones (memory reloads automatically).

Target: 9 milestones to launch → roughly **3–4 weeks** with Claude Code doing the coding and you
testing/reviewing on your phone (faster if full time).

---

## How the AI works (the big picture)

```
 User uploads 200 photos
        │
 ① METADATA (free, in the browser, no AI)
   EXIF date/time, GPS, camera, size, orientation
   + duplicate detection (perceptual hash) + blur score + low-resolution check
        │
 ② AI LOOKS AT EVERY PHOTO (Claude vision, small 512px thumbnails, 10 photos per request)
   → description, scene, people count, mood, quality 1–10, "keep or drop" + reason
   → drops: screenshots, receipts, memes, blurry, near-duplicates (keeps the best of each group)
        │
 ③ AI PLANS THE ALBUM (one Claude call over all the photo notes + dates + places)
   → splits into MOMENTS/chapters ("Day 1 – Arrival in Paris", "Mehndi night", "Beach afternoon")
   → picks the best photos per moment, orders them, chooses a layout per page, picks the cover
   → writes book title + subtitle
        │
 ④ AI WRITES QUOTES & CAPTIONS (per moment / per page)
   → short original lines grounded in what's actually in the photos, in the chosen tone + language
        │
 ⑤ USER REVIEWS & EDITS EVERYTHING
   → "AI kept 64 of 200 photos" screen: restore any dropped photo, remove any kept one
   → editor: change layouts, swap photos, edit any caption, "✨ rewrite" button (tone: romantic / fun /
     nostalgic / minimal, English / Arabic)
```

Key rule: **AI drafts, the user decides.** Nothing the AI does is final; every choice is editable.

### AI cost per book (estimate, Claude Opus 5.5 at $4 / $20 per million tokens)
| Step | ~Tokens for 200 photos | ~Cost |
|---|---|---|
| ② Photo analysis (512px thumbnails) | ~70k in / ~16k out | ~$0.60 |
| ③ Album plan | ~20k in / ~5k out | ~$0.18 |
| ④ Quotes | ~8k in / ~3k out | ~$0.09 |
| **Total** | | **≈ $0.85 per 200-photo book** (≈ AED 3) |

These numbers are rough estimates; measure real token usage in M3 (we log it in `agent_steps` / `agent_runs.total_cost_usd`).
Against an AED 39 sale this is fine, but free users also cost AED ~3 each → see the free-tier AI limits
in CLAUDE.md. If costs are too high, a cheaper model (Claude Haiku 5.5) can be used for step ② only —
that's a product decision for you; the code makes the model a single config value.

---

## Before you start (only you can do these — ~1 hour)
- [ ] Install Node 20+, Git, and Claude Code; `cd ~/photobook-app && claude`
- [ ] Accounts: GitHub, Vercel, Supabase (region Frankfurt `eu-central-1` or Mumbai `ap-south-1`), Stripe,
      **Anthropic Console** (console.anthropic.com → API key, add ~$20 credit, set a monthly spend limit)
- [ ] Mapbox account (free tier) for turning GPS into place names
- [ ] Stripe: test mode now. Live mode in the UAE needs a trade licence (free-zone is fine) + UAE bank —
      start that paperwork now.
- [ ] `.env.local` keys: `NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, AI_MODE, ADMIN_USER_IDS,
      ANTHROPIC_API_KEY, MAPBOX_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_APP_URL, CRON_SECRET`
- [ ] Privacy policy must say photos are processed by an AI provider (Anthropic) to build the album.

---

## Milestone 0 — Project skeleton (½ day)
- [x] Next.js 15 + TypeScript + Tailwind + shadcn/ui + ESLint + Vitest + Playwright
- [x] Supabase client helpers (browser, server, service-role) in `src/lib/supabase/`
- [x] Folder structure (below), `.env.example`, `npm run typecheck`
- [x] Landing placeholder, mobile-first base layout, Inter + Cairo fonts
- [x] Push to GitHub, connect Vercel, first deploy
**Done when:** the Vercel URL shows the landing page on your phone.

## Milestone 1 — Database + login (½ day)
- [x] Migration with all tables below + RLS (owner-only; public read of published books via a security-definer function)
- [x] Storage buckets: `photos` (private), `exports` (private)
- [x] Auth: email magic link + Google; `/login`, `/dashboard` (protected), "My books" list + "New book"
**Done when:** you can log in on your phone and see an empty dashboard.

## Milestone 2 — Upload + metadata extraction (1–2 days) ⭐
- [x] `/books/new`: choose occasion (Wedding, Travel, Baby, Graduation, Family, Other) + tone + caption language (EN/AR) + title (optional — AI can suggest)
- [x] Multi-photo upload from phone gallery, batches of 10, progress bar, resumable (built as one photo at a time — see runs/m2.md)
- [x] **Read EXIF with `exifr` BEFORE converting HEIC → JPEG** (conversion strips EXIF): date taken, GPS, camera, orientation
- [x] If no EXIF (common for photos received on WhatsApp): fall back to `file.lastModified`, mark `date_source = 'file'`
- [x] Generate 3 sizes client-side: `original`, `web` (≤1600px), `thumb` (512px, for AI) → Storage
- [x] In-browser quality signals: perceptual hash (dHash 64-bit) for duplicates, blur score (Laplacian variance on canvas), resolution
- [x] Server: cluster GPS points (~1 km) and reverse-geocode **once per cluster** via Mapbox → `place` ("Louvre, Paris")
- [x] Simple rule-based auto-layout (`src/lib/autolayout.ts`, Vitest-tested) as the **fallback** if AI fails
**Done when:** 100 phone photos upload and each row has date, place, size, hash and blur score. ✅ 110 photos on iPhone (2026-11-08) — place verified only in e2e: the phone upload arrived with no GPS (see progress.md).

## Milestone 3 — AI agent pipeline: curation + album generation (3–4 days) ⭐⭐ the magic
Design: **docs/AI-AGENTS.md** (Curator → Storyteller → Caption Writer → Critic, code orchestrator, logging, memory).
- [x] Migration: `agent_runs`, `agent_steps`, `user_memory` (replace `ai_usage`)
- [x] `src/lib/ai/run-step.ts` (`runAgentStep` logs every call) + `orchestrator.ts` (state machine, resumable)
- [x] Live progress: `GET /api/ai/runs/[id]` + progress screen
- [x] `src/lib/ai/` module — all Claude calls live here (see CLAUDE.md → AI rules)
- [ ] **Step A – analyse photos** (built + replay-tested, live pending M3b; endpoint is `/api/ai/runs` + advance ticks per D-022/D-025): takes 10 photo IDs, sends their 512px thumbnails + metadata,
      returns structured JSON per photo (schema below). Client calls it in parallel batches (3 at a time) with a
      progress screen: "Looking at your photos… 120 / 200"
- [ ] Duplicate groups (from pHash): AI picks the best shot of each group, the rest marked `dropped: duplicate` (built + replay-tested, live pending M3b)
- [ ] **Step B – plan album** (built + replay-tested, live pending M3b; Storyteller tick in `/api/ai/runs/[id]/advance`): sends all photo notes (text only, no images) + dates + places + occasion +
      target page count → returns moments, page plan (layout IDs only from our list), cover, title (schema below)
- [x] Validate the plan in code: every photoId exists, layout slot count matches photos, page count within limit;
      if invalid → retry once, then fall back to rule-based auto-layout
- [x] **Review screen** `/books/[id]/review`: "AI kept 64 of 200" — grid of kept / dropped (with reason chip),
      tap to toggle, "Rebuild album" button
- [x] Every call logged in `agent_steps` via `runAgentStep`; enforce free-tier limits
- [x] `/admin/runs/[id]` trace page (step timeline, outputs, cost)
**Done when:** 150 mixed photos (incl. screenshots, duplicates, blurry ones) become a sensible, chaptered book in < 90 s,
and the trace page shows every agent step with its cost.
**M3a done (replay) 2026-11-09** — everything built, tested with recorded answers and deployed; AI is `off` in production. **M3b** needs `ANTHROPIC_API_KEY`: one real 150-photo book (< 90 s, cost per book, cache hits), prompt tuning, re-recorded fixtures, iPhone GPS-hint check. Also built: free "Update album" re-layout (D-028).

## Milestone 4 — AI quotes & captions (1 day) ⭐
- [ ] Caption Writer step inside the AI run (D-029; no `/api/ai/captions`): batches of moments ≤ 12 captionable pages, sends
      moment title + photo notes + occasion + tone + language → one quote per captionable page + a short chapter heading
      (built + replay-tested, live pending M4b)
- [ ] Rules in the prompt (built + replay-tested; deterministic pre-check D-030; real quality pending M4b): original lines only (no famous quotes/lyrics), ≤ 18 words, grounded in what's visible,
      never invent names or facts, Arabic written natively (not translated word-by-word) when language = AR
- [x] Captions stored in the book doc with `source: "ai"`; once the user edits one it becomes `source: "user"`
      and AI rebuilds never overwrite it
- [ ] **Critic agent** + one targeted repair round (rubric in docs/AI-AGENTS.md) (built + replay-tested, live pending M4b)
- [x] **User memory**: inject `user_memory` into Storyteller / Caption Writer; Memory Keeper updates it on review
      Continue (D-032; later also editor exit + publish); Settings page to view / clear it
**Done when:** a generated book has fitting quotes on every page, in English or Arabic; the Critic catches a
planted bad caption in tests; a second book reflects the user's earlier tone/length choices.
**M4a done (replay) 2026-11-09** — planted bad caption caught + repaired (replay), second book reflects memory (replay), Arabic captions native-script with Cairo; "fitting quotes on every page" (every page with a caption area) waits for **M4b** with the live key (together with M3b). Also: per-run cost cap (D-035), migration 0800 (cursor 256 KB).

## Milestone 5 — Editor (2–3 days) ⭐
- [x] `/books/[id]/edit`: page strip + big current page; mobile = swipe pages, bottom toolbar
- [x] Shared `<BookPage doc page mode="edit|view|print">` used by editor, viewer and PDF
- [x] Change layout (photos re-flow), replace photo (from the book's kept + dropped photos), pan & zoom crop
- [x] Edit captions inline (`dir="auto"`), fonts: Inter, Playfair, Cairo, Tajawal
- [ ] **✨ AI caption button** on every caption: rewrite / shorter / change tone / translate EN↔AR (one call, ~1 s) — built + replay-tested; live latency/quality pending M5b (API key)
- [x] Add / delete / reorder pages (dnd-kit), edit cover title + subtitle, move a page to another chapter
- [x] Autosave (debounced 2 s) + "Saved ✓"; low-resolution warning on slots
- [x] Free limit: block page 21 with "Upgrade"
**Done when:** you can fully customise an AI-generated 20-page book on your phone without frustration.
> M5a (2026-11-10): built + tested (2111 unit, 45 editor e2e at 375 px, live signed-in pre-0900). Live save needs migration 0900 (deploy code first, then `db push`); phone "Done when" check is NEEDS-HUMAN.

## Milestone 6 — Publish + flipbook viewer + sharing (1 day)
- [x] Publish → unique slug, `published_at`, `expires_at = now + 30 days` if unpaid
- [x] `/b/[slug]`: `react-pageflip` flipbook, swipe, fullscreen, page counter, chapter headings
- [x] Watermark if unpaid + "Made with <App> — create yours" footer (growth loop)
- [x] Expired page, WhatsApp / copy / native share, OG image via `next/og`, optional password
**Done when:** a WhatsApp link previews nicely and flips smoothly on another phone.
> M6 (2026-11-10): built + tested (2477 unit, 22 e2e, live publish-auth 8/1 skip), reviewed + re-review APPROVED, PGlite rls_check 106 ✓. Deployed 2026-11-10 (main 86114f7, migration 1100 live). "Done when" (WhatsApp preview + flip on another phone) is NEEDS-HUMAN after deploy.

## Milestone 7 — Payments (1 day)
- [x] "Upgrade this book — AED 39" → Stripe Checkout (`aed`, Apple Pay / Google Pay)
- [x] Webhook `checkout.session.completed` → `orders` row, `is_paid = true`, `expires_at = null`, `max_pages = 100`, AI limits raised
- [ ] Test with `stripe listen --forward-to localhost:3000/api/stripe/webhook`
**Done when:** a test payment removes the watermark on the live link.
> M7 (2026-11-10): built + reviewed (APPROVED). Live spec vs prod DB with signed test events 7/7 (watermark removed, 21 pages save, replay no-op, wrong amount stays free, expired link revived, refund keeps paid). Migrations 1200 + 1300 applied (rls_check 121). Deployed 2026-11-10 (main 5e7f181; dormant until keys). Real Stripe test-mode payment (`stripe listen` + card 4242, Apple/Google Pay on phone) is NEEDS-HUMAN — needs a Stripe account + keys.

## Milestone 8 — PDF export (1–2 days)
- [x] `/print/[bookId]?token=…` renders exact A5 pages (148×210 mm + 3 mm bleed) with `original` photos
- [x] `/api/books/[id]/pdf` (paid only): Puppeteer + `@sparticuz/chromium` → `exports` bucket → signed URL
- [x] Check Arabic quotes shape correctly; if Vercel limits hit → move this endpoint to a small worker (Railway/Fly.io)
**Done when:** a paid 40-page book downloads as a crisp PDF in < 60 s.
> M8 (2026-11-10): built + reviewed (APPROVED). Live vs prod DB: 40-page paid book → 41-page PDF in 15.8 s locally (Type0 fonts, 300 dpi, 3 mm bleed, Arabic shaped, no EXIF). Migrations 1400 + 1500 applied (rls_check 146). Deployed 2026-11-10 (main 952b737). On Vercel Hobby (Fluid, 300 s, 2 GB/1 vCPU) the timing is NEEDS-HUMAN; Pro before real payments.

## Milestone 9 — Clean-up, polish, launch (1–2 days)
- [x] Daily cron: delete unpaid books + photos 30 days after publish; abandoned drafts after 45 days; orphan uploads after 7 days
- [x] Emails (Resend): "Your book expires in 3 days"
- [ ] Landing page: "Upload 200 photos → AI builds your album in 60 seconds" demo video, 3 example flipbooks, pricing, FAQ
- [x] Legal pages (mention AI processing), analytics (PostHog), errors (Sentry), AI spend dashboard (sum of `agent_runs.total_cost_usd` per day)
- [x] Playwright smoke: login → upload → AI build → edit caption → publish → view → pay (test mode)
- [ ] Stripe live mode when licence is ready → 🚀 launch
> M9 (2026-11-10): built + reviewed (APPROVED); launch smoke 7/7 live. Landing page built (pricing, FAQ, how it works) — demo video + 3 example books wait for the seed/record scripts (NEEDS-HUMAN photos). Migrations 1600–1800 in prod. Deployed 2026-11-10 (main e7cf172); cron inactive until CRON_SECRET is set. Launch checklist: docs/LAUNCH.md; operations: docs/RUNBOOK.md.

## Milestone 10 — Book design system (spreads, landscape, styles, backgrounds)
Plan + decisions: `.agentos/runs/m10.md`, D-062. Three shippable phases.
- [x] M10a: doc v2 (upgrade on read, v1 on write), portrait + landscape geometry, backgrounds (colour / own paper textures / faded photo; page or whole book) in editor, viewer and PDF, open-book (facing pages) editor ≥ 768 px + phone "View spread"
- [x] M10b: landscape layouts, two-page spread layouts, modern style (split-strip cover, text panel, grids), new OFL fonts (script / display / serif + Arabic pairs), format + style on new books, AI per format/style (migration 1900, migration first)
- [x] M10c: geometric + scrapbook styles (shapes, frames, tilt, own stickers incl. Eid/Ramadan), crop on shaped slots, photo colour at upload, AI-suggested backgrounds (Geometric/Scrapbook/Modern; kept photos only, user choices never overwritten), occasion → default style (D-068); Restyle stays out (D-063)
**Done when:** a user builds a landscape or portrait book in any style with spreads and backgrounds that look the same in editor, flipbook and PDF.
> M10c (2026-11-12): built (36 layouts: geometric 18, scrapbook 18), G0 + G1 signed off, reviewed APPROVED (privacy fix: AI photo backgrounds of dropped photos never publish/export), gate PASS: 6716 vitest, m9/m10b goldens identical, m10c goldens frozen, e2e/m10c 7/7 + m10c-privacy 4/4 live, 100-page scrapbook PDF ready (peak ≤1.5 GB), flipbook ~60 fps. No migration. Deployed 2026-11-12.
> M10b: migration 1900 applied to prod 2026-11-11 (rls 175).
> M10b (2026-11-11): built, re-reviewed (APPROVED), live specs green (m10b 7/7, pdf 7/7, ai-auth 15/15, editor 62, editor-spreads 8, viewer 14, m10b-viewer 6, launch-smoke, m10a, publish-auth, payments, analytics), goldens (m9 byte-frozen + m10b). PDF chunks ≤20 sheets / ≤60 distinct images, spread cap 1.5×. Deployed 2026-11-11 (main d922e15). Post-deploy: one real prod PDF with Arabic + new fonts (no Type3 / missing glyphs) and a real-photo large-book size check.
> M10a (2026-11-10): built, reviewed (APPROVED), live e2e/m10a 7/7, launch-smoke 7/7, editor 59/59, goldens byte-frozen. No migration. NOT deployed. Needs user sign-off on fonts/textures (docs/design/) before M10b.

## Milestone 11 — App UX polish (before M10c)
App screens take on the book look (Classic serif / Modern clean); app chrome only — BookPage, print and layouts unchanged. Plan: `.agentos/runs/m11.md`, D-067.
- [x] Design foundation: app tokens (paper palette, Playfair display + Inter/Cairo body, radius, shadow, spacing), 44 px buttons, shared PageHeader / StepProgress / Notice / EmptyState / Loading / Toast; style board signed off (docs/design/m11-style-board-*.png)
- [x] App shell: header + account menu, loading skeletons on every signed-in route, app not-found + error pages
- [x] Landing, login, settings, dashboard (book cards with cover thumbnails), New book form (grouped, correct "fixed at creation" copy)
- [x] Upload → AI build (real-stage checklist) → Review (one clear Continue / Update album / Rebuild hierarchy), step progress across the flow
- [x] Editor on a phone: docked Layout + Replace pickers (page stays visible), clearer toolbar, one-time hint, consistent sheets/toasts
- [x] Publish & share (WhatsApp first, free vs paid card), upgrade/payment states, PDF download, public viewer chrome
- [x] e2e/m11.spec.ts: every screen at 375 px — no sideways scroll, ≥ 44 px targets, visible focus, AA contrast
**Done when:** on a 375 px phone a new user goes landing → login → new book → upload → AI build → review → edit → publish → share → upgrade → PDF in one consistent Classic/Modern look, always knows the next step, never scrolls sideways; m9 + m10b goldens and the print pixel baseline are unchanged, analytics events still fire, all live specs are green.
> M11 (2026-11-11): built (5 parallel builders after style-board sign-off), reviewed APPROVED (fixes applied), gate PASS: 5347 vitest, goldens unchanged, book render parity 0 px over 112 captures, e2e/m11 375 a11y spec, all live specs green (upload-auth only Mapbox). First-load JS within +3 kB of pre-M11 (/ −3). WhatsApp button green (user). Deployed 2026-11-11 (main 97bcbd8).

## Milestone 12 — Reliability (before launch)
Plan: `.agentos/runs/m12.md`, D-069.
- [x] Time limits on every Supabase call (server + browser): reads, RPCs, signed URLs, uploads and downloads each get their own budget; a timeout becomes a typed `SUPABASE_TIMEOUT` → 503 "try again" (never a sign-out or login redirect)
- [x] Safe retries after a timeout: editor save replay is not a false "changed in another tab"; finalize, AI tick, PDF export and Stripe webhook stay idempotent; AI lease margin covers database budgets
- [x] Upload + build screens recover by themselves: finalize request deadline + 503 back-off; a stalled photo upload is retried
- [x] Small fixes: "Add photo" on an empty split-strip cover in the editor; layout picker no longer re-plans every layout on each render; PDF reference walk without a depth limit
- [x] e2e/m12-reliability.spec.ts (stalled upload recovers at 375 px) + all live specs green
**Done when:** no server route or upload can hang past its time limit; a hung or slow Supabase response shows a retry (never the login page) and the flow recovers on its own; autosave never reports a false conflict after a timeout; goldens unchanged; lint, typecheck, tests and live specs pass.
> M12 (2026-11-12): built, reviewed (fixes applied: autosave 503 retry, cookie carry, caption serverBusy, getCurrentUser cap), gate PASS on 7862a6f: 6897 vitest, goldens unchanged, e2e/m12-reliability 5/5 live, regressions green (upload-auth Mapbox only; ai-auth e AI-off rebuild refresh hang is pre-existing on main). No migration. Deployed 2026-11-12 (main f6a7bc9).

## Milestone 13 — Easiest flow (photos to shared book in 3 taps)
Plan: `.agentos/runs/m13.md`, D-070.
- [x] Photos first: "Make your book" / "New book" opens the photo picker; the draft book is created with smart defaults
- [x] One setup card while uploading (occasion chips; feel, language, shape and style under "Change", prefilled from occasion, device and photos)
- [x] AI build starts by itself after the first upload; the build screen shows the draft book while AI polishes
- [x] Build goes straight to the editor; "AI kept X of Y" chip opens the left-out photos
- [x] Simple editor: at most 3 big tools per selection plus "More"; plain words instead of jargon
- [x] "Share" = publish + share screen (WhatsApp first, upgrade and PDF on the same screen); 3-step progress bar
- [x] e2e/m13-first-run.spec.ts + usability sign-off (screenshots in docs/design/m13-after-*)
**Done when:** at 375 px a first-time user (40 photos, AI replay) needs at most 3 app taps after choosing photos to reach the WhatsApp share, the first preview shows in under 60 s, all analytics events fire, all specs and goldens are green, the user signs off the walkthrough, and the reviewer approves.
> M13 (2026-11-13): built, reviewed APPROVED (fixes applied), gate PASS: 7221 vitest, goldens unchanged, e2e/m13-first-run (2 taps after photos vs 5; first preview ~36 s vs ~75 s; WhatsApp ~61 s vs ~80 s), all live specs green (upload-auth Mapbox only). User signed off the walkthrough. Deployed 2026-11-13. No migration. Open: guest mode (M13b) after measuring login drop-off; Arabic default cover title for untitled Arabic books.

## Milestone 10+ — After launch
- [ ] Printing in the UAE (print-shop partner, print-ready PDF, address checkout, Aramex delivery, `/admin/orders`)
- [ ] AI "story mode": a short paragraph per chapter (AI-picked backgrounds moved into M10c)
- [ ] Shared albums (family members upload to one book), ambassador codes, Arabic UI, RTL books

---

## Folder structure
```
src/
  app/
    (marketing)/page.tsx
    login/  dashboard/
    books/new/  books/[id]/review/  books/[id]/edit/
    b/[slug]/                         public flipbook (+ opengraph-image.tsx)
    print/[bookId]/
    api/ai/runs/ (+ [id], [id]/advance)  api/ai/rewrite/
    api/books/[id]/finalize/  books/[id]/upgrade/ (actions + success)  api/stripe/webhook/  api/books/[id]/pdf/  api/cron/cleanup/
  components/book/BookPage.tsx
  components/editor/  components/viewer/  components/review/
  lib/ai/  (client.ts, prompts.ts, schemas.ts, analyze.ts, plan.ts, captions.ts, limits.ts)
  lib/image/ (exif.ts, phash.ts, blur.ts, resize.ts)
  lib/layouts/  lib/autolayout.ts  lib/db/  lib/supabase/  lib/stripe.ts
supabase/migrations/
tests/ (vitest — schemas, plan validation, autolayout)   e2e/ (playwright)
```

## Database tables
```
profiles   id (= auth.users.id), name, created_at
books      id, user_id, title, occasion, tone, caption_lang ('en'|'ar'),
           slug (unique, null until published), doc jsonb, page_count,
           ai_status ('idle'|'analyzing'|'planning'|'captioning'|'done'|'failed'),
           is_paid bool default false, max_pages int default 20, password_hash null,
           published_at, expires_at, created_at, updated_at
photos     id, user_id, book_id, original_path, web_path, thumb_path, width, height,
           taken_at, date_source ('exif'|'file'), lat, lng, place, camera,
           phash text, blur_score real, dup_group int null,
           ai jsonb null,                      -- result of Step A (schema below)
           status ('kept'|'dropped') , drop_reason text null, user_override bool default false,
           created_at
agent_runs, agent_steps, user_memory   → see docs/AI-AGENTS.md → "Database additions"
orders     id, user_id, book_id, type ('digital'|'print'), amount, currency, status,
           stripe_session_id unique, created_at
```

## AI output schemas (Zod, in `src/lib/ai/schemas.ts`)
```ts
// Step A — per photo
PhotoAnalysis = {
  photoId: string,
  description: string,                 // "Couple laughing on a balcony, Eiffel Tower behind"
  scene: "portrait"|"group"|"landscape"|"food"|"detail"|"document"|"screenshot"|"other",
  peopleCount: number,
  mood: "joyful"|"romantic"|"calm"|"adventurous"|"nostalgic"|"formal"|"neutral",
  quality: number,                     // 1–10 (sharpness, exposure, composition, faces visible)
  coverWorthy: boolean,
  keep: boolean,
  dropReason: null|"screenshot"|"document"|"blurry"|"duplicate"|"poor_quality"|"irrelevant",
}

// Step B — album plan
AlbumPlan = {
  title: string, subtitle: string,
  coverPhotoId: string,
  moments: [{ id: string, title: string, dateLabel: string, place: string|null,
              pages: [{ layoutId: string, photoIds: string[] }] }],
}

// Step C — captions (per moment)
MomentCaptions = { momentId: string, heading: string,
                   pageCaptions: [{ pageIndex: number, text: string }] }
```

## Book document format (`books.doc`)
```json
{
  "version": 1,
  "format": "A5_PORTRAIT",
  "occasion": "wedding",
  "cover": { "layout": "cover", "photoId": "p1", "title": "Sara & Omar", "subtitle": "Abu Dhabi · 2026" },
  "chapters": [
    { "id": "m1", "title": "The Mehndi Night", "dateLabel": "12 Oct 2026", "place": "Abu Dhabi" }
  ],
  "pages": [
    {
      "id": "pg1",
      "chapterId": "m1",
      "layout": "two-vertical",
      "slots": [
        { "photoId": "p2", "crop": { "x": 0.5, "y": 0.4, "zoom": 1.0 } },
        { "photoId": "p3", "crop": { "x": 0.5, "y": 0.5, "zoom": 1.2 } }
      ],
      "caption": { "text": "أجمل ليلة بدأت بضحكة", "font": "Cairo", "align": "center", "source": "ai" }
    }
  ],
  "style": { "background": "#FFFFFF", "font": "Playfair" }
}
```

### v2 (M10a, D-062)
Schema: `src/lib/book/schema.ts`; versions: `src/lib/book/doc-version.ts`. `parseBookDoc` accepts v1 or
v2 and always returns v2 (v1 upgrades 1:1: hex → `{kind:"color"}`, `designStyle: "classic"`). Writers store
`serializeDoc(doc)`: **v1 whenever no v2 feature is used** (existing books stay byte-identical), else v2.
Differences from v1:
- `"version": 2`; `"format": "A5_PORTRAIT" | "A5_LANDSCAPE"` (landscape = M10b).
- `style.background` is a Background union (strict objects):
  `{kind:"color", hex}` · `{kind:"texture", textureId, tint?}` (texture ids from `src/lib/design/backgrounds.ts`;
  editor saves only accept light-swatch tints) · `{kind:"photo", photoId, veil 0.5–0.9, veilColor}` (faded photo,
  no blur; any ready photo of the book, kept or dropped).
- `style.designStyle?`: `classic | modern | geometric | scrapbook` (absent = classic).
- `style.backgroundSource?`: `ai | user` (M10c D5, D-068): who chose the book background. AI suggestions
  (`src/lib/design/background-suggest.ts`, Modern/Geometric/Scrapbook only) replace it only when absent/`ai`;
  the editor's Whole-book pick sets `user` (not in Classic). Stripped from the published doc.
- `pages[].background?`: page override = a Background + `source: "ai" | "user"` (AI never overwrites `user`);
  absent/null = book default. `pages[].side?`: `left | right` (spread halves, M10b).
- Up to 12 slots per page (v1: 8).
- v2 features: non-portrait format, non-colour book background, `style.backgroundSource`, non-classic style,
  any page background or side, > 8 slots. Until M10b the editor save keeps `format`, `designStyle` and `side` as stored.
- Deleting a photo clears its slots/cover and removes backgrounds using it (book default → white; an AI book
  background → the style default). Update album also removes an AI photo background whose photo is no longer kept.

### Spreads (M10b A2, D-064) — `src/lib/book/spreads.ts`
- Pairing = editor/viewer: cover alone, then `pages[0,1]`, `[2,3]`, … A spread layout is stored as two pages:
  `pages[2k]` = `side:"left"`, the spread layout id, ALL slots (+ caption), rects in 0–200 % x;
  `pages[2k+1]` = `side:"right"`, same layout id, `slots: []`, `caption: null` (may carry its own background).
  A spread counts as 2 pages. Single-page layouts never carry `side`.
- `validateBookDoc` rejects: misaligned spread (left half on odd index), right half without left, spread with no
  right half (e.g. last page), side on a single layout, slots/caption on a right half, layout format ≠ `doc.format`.
- `repairSpreads(doc)` splits a misaligned spread into its `twin` single layouts (slot → half by its centre), keeping
  every photo, crop, caption and background; a too-small twin → smallest bigger layout of the format/style.
- v2 features also: any spread / non-classic layout, caption fonts in `src/lib/book/fonts-v2.ts`.

## Layout definition (`src/lib/layouts/two-vertical.ts`)
```ts
export const twoVertical: Layout = {
  id: "two-vertical",
  name: "2 photos side by side",
  role: "page",                            // "page" | "spread" | "cover"
  style: "classic",                        // classic | modern | geometric | scrapbook (M10b)
  format: "A5_PORTRAIT",                   // A5_PORTRAIT | A5_LANDSCAPE — must match doc.format
  photoCount: 2,                           // ≤ 12
  prefers: ["portrait", "portrait"],      // hint for AI + rule-based fallback
  slots: [ { x: 5, y: 8, w: 43, h: 72 }, { x: 52, y: 8, w: 43, h: 72 } ],   // % of page
  caption: { x: 5, y: 84, w: 90, h: 10 },
  // spreads only: twin: ["left-single-id", "right-single-id"]; x in 0–200 %
  // optional texts: [{ bind: "chapterTitle"|"dateLabel"|"pageCaption"|"coverTitle"|"coverSubtitle",
  //                    box: {x,y,w,h}, align: "start"|"center"|"end", font: "title"|"subtitle"|"year"|"chapter"|"caption" }]  // = styles.ts TEXT_ROLES
};
```

---

## Tips for building fast with Claude Code
1. **One milestone per session**, start with the line at the top, `/clear` when done.
2. **Plan mode** (Shift+Tab) for M2, M3, M5 and M8 — review the plan before it writes code.
3. **Keep a test photo set** in `~/photobook-test-photos/` (≈150 real photos incl. screenshots, duplicates,
   blurry shots, WhatsApp-received photos with no EXIF). Use it every time you test M2–M4.
4. **Test on your phone** (`npm run dev -- -H 0.0.0.0` → `http://<mac-ip>:3000`). Report bugs as
   "On iPhone Safari, X happens; expected Y" + screenshot.
5. **Tune AI prompts with real examples**: when a quote or a pick is bad, paste the photo note + output into
   Claude Code and ask it to adjust `src/lib/ai/prompts.ts`.
6. Commit after every milestone. Park new ideas under "Ideas" below.

## Ideas (parking lot)
-
