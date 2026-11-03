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

These numbers are rough estimates; measure real token usage in M3 (we log it in `ai_usage`).
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
- [ ] `.env.local` keys: `NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
      ANTHROPIC_API_KEY, MAPBOX_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_APP_URL, CRON_SECRET`
- [ ] Privacy policy must say photos are processed by an AI provider (Anthropic) to build the album.

---

## Milestone 0 — Project skeleton (½ day)
- [x] Next.js 15 + TypeScript + Tailwind + shadcn/ui + ESLint + Vitest + Playwright
- [x] Supabase client helpers (browser, server, service-role) in `src/lib/supabase/`
- [x] Folder structure (below), `.env.example`, `npm run typecheck`
- [x] Landing placeholder, mobile-first base layout, Inter + Cairo fonts
- [ ] Push to GitHub, connect Vercel, first deploy
**Done when:** the Vercel URL shows the landing page on your phone.

## Milestone 1 — Database + login (½ day)
- [ ] Migration with all tables below + RLS (owner-only; public read of published books via a security-definer function)
- [ ] Storage buckets: `photos` (private), `exports` (private)
- [ ] Auth: email magic link + Google; `/login`, `/dashboard` (protected), "My books" list + "New book"
**Done when:** you can log in on your phone and see an empty dashboard.

## Milestone 2 — Upload + metadata extraction (1–2 days) ⭐
- [ ] `/books/new`: choose occasion (Wedding, Travel, Baby, Graduation, Family, Other) + tone + caption language (EN/AR) + title (optional — AI can suggest)
- [ ] Multi-photo upload from phone gallery, batches of 10, progress bar, resumable
- [ ] **Read EXIF with `exifr` BEFORE converting HEIC → JPEG** (conversion strips EXIF): date taken, GPS, camera, orientation
- [ ] If no EXIF (common for photos received on WhatsApp): fall back to `file.lastModified`, mark `date_source = 'file'`
- [ ] Generate 3 sizes client-side: `original`, `web` (≤1600px), `thumb` (512px, for AI) → Storage
- [ ] In-browser quality signals: perceptual hash (dHash 64-bit) for duplicates, blur score (Laplacian variance on canvas), resolution
- [ ] Server: cluster GPS points (~1 km) and reverse-geocode **once per cluster** via Mapbox → `place` ("Louvre, Paris")
- [ ] Simple rule-based auto-layout (`src/lib/autolayout.ts`, Vitest-tested) as the **fallback** if AI fails
**Done when:** 100 phone photos upload and each row has date, place, size, hash and blur score.

## Milestone 3 — AI agent pipeline: curation + album generation (3–4 days) ⭐⭐ the magic
Design: **docs/AI-AGENTS.md** (Curator → Storyteller → Caption Writer → Critic, code orchestrator, logging, memory).
- [ ] Migration: `agent_runs`, `agent_steps`, `user_memory` (replace `ai_usage`)
- [ ] `src/lib/ai/run-step.ts` (`runAgentStep` logs every call) + `orchestrator.ts` (state machine, resumable)
- [ ] Live progress: `GET /api/ai/runs/[id]` + progress screen
- [ ] `src/lib/ai/` module — all Claude calls live here (see CLAUDE.md → AI rules)
- [ ] **Step A – analyse photos**: `/api/ai/analyze` takes 10 photo IDs, sends their 512px thumbnails + metadata,
      returns structured JSON per photo (schema below). Client calls it in parallel batches (3 at a time) with a
      progress screen: "Looking at your photos… 120 / 200"
- [ ] Duplicate groups (from pHash): AI picks the best shot of each group, the rest marked `dropped: duplicate`
- [ ] **Step B – plan album**: `/api/ai/plan` sends all photo notes (text only, no images) + dates + places + occasion +
      target page count → returns moments, page plan (layout IDs only from our list), cover, title (schema below)
- [ ] Validate the plan in code: every photoId exists, layout slot count matches photos, page count within limit;
      if invalid → retry once, then fall back to rule-based auto-layout
- [ ] **Review screen** `/books/[id]/review`: "AI kept 64 of 200" — grid of kept / dropped (with reason chip),
      tap to toggle, "Rebuild album" button
- [ ] Every call logged in `agent_steps` via `runAgentStep`; enforce free-tier limits
- [ ] `/admin/runs/[id]` trace page (step timeline, outputs, cost)
**Done when:** 150 mixed photos (incl. screenshots, duplicates, blurry ones) become a sensible, chaptered book in < 90 s,
and the trace page shows every agent step with its cost.

## Milestone 4 — AI quotes & captions (1 day) ⭐
- [ ] `/api/ai/captions`: per moment, send the moment title + photo notes + occasion + tone + language →
      returns one quote per page + a short chapter heading
- [ ] Rules in the prompt: original lines only (no famous quotes/lyrics), ≤ 18 words, grounded in what's visible,
      never invent names or facts, Arabic written natively (not translated word-by-word) when language = AR
- [ ] Captions stored in the book doc with `source: "ai"`; once the user edits one it becomes `source: "user"`
      and AI rebuilds never overwrite it
- [ ] **Critic agent** + one targeted repair round (rubric in docs/AI-AGENTS.md)
- [ ] **User memory**: inject `user_memory` into Storyteller / Caption Writer; Memory Keeper updates it on publish;
      Settings page to view / clear it
**Done when:** a generated book has fitting quotes on every page, in English or Arabic; the Critic catches a
planted bad caption in tests; a second book reflects the user's earlier tone/length choices.

## Milestone 5 — Editor (2–3 days) ⭐
- [ ] `/books/[id]/edit`: page strip + big current page; mobile = swipe pages, bottom toolbar
- [ ] Shared `<BookPage doc page mode="edit|view|print">` used by editor, viewer and PDF
- [ ] Change layout (photos re-flow), replace photo (from the book's kept + dropped photos), pan & zoom crop
- [ ] Edit captions inline (`dir="auto"`), fonts: Inter, Playfair, Cairo, Tajawal
- [ ] **✨ AI caption button** on every caption: rewrite / shorter / change tone / translate EN↔AR (one call, ~1 s)
- [ ] Add / delete / reorder pages (dnd-kit), edit cover title + subtitle, move a page to another chapter
- [ ] Autosave (debounced 2 s) + "Saved ✓"; low-resolution warning on slots
- [ ] Free limit: block page 21 with "Upgrade"
**Done when:** you can fully customise an AI-generated 20-page book on your phone without frustration.

## Milestone 6 — Publish + flipbook viewer + sharing (1 day)
- [ ] Publish → unique slug, `published_at`, `expires_at = now + 30 days` if unpaid
- [ ] `/b/[slug]`: `react-pageflip` flipbook, swipe, fullscreen, page counter, chapter headings
- [ ] Watermark if unpaid + "Made with <App> — create yours" footer (growth loop)
- [ ] Expired page, WhatsApp / copy / native share, OG image via `next/og`, optional password
**Done when:** a WhatsApp link previews nicely and flips smoothly on another phone.

## Milestone 7 — Payments (1 day)
- [ ] "Upgrade this book — AED 39" → Stripe Checkout (`aed`, Apple Pay / Google Pay)
- [ ] Webhook `checkout.session.completed` → `orders` row, `is_paid = true`, `expires_at = null`, `max_pages = 100`, AI limits raised
- [ ] Test with `stripe listen --forward-to localhost:3000/api/stripe/webhook`
**Done when:** a test payment removes the watermark on the live link.

## Milestone 8 — PDF export (1–2 days)
- [ ] `/print/[bookId]?token=…` renders exact A5 pages (148×210 mm + 3 mm bleed) with `original` photos
- [ ] `/api/books/[id]/pdf` (paid only): Puppeteer + `@sparticuz/chromium` → `exports` bucket → signed URL
- [ ] Check Arabic quotes shape correctly; if Vercel limits hit → move this endpoint to a small worker (Railway/Fly.io)
**Done when:** a paid 40-page book downloads as a crisp PDF in < 60 s.

## Milestone 9 — Clean-up, polish, launch (1–2 days)
- [ ] Daily cron: delete unpaid books + photos 30 days after publish; abandoned drafts after 45 days; orphan uploads after 7 days
- [ ] Emails (Resend): "Your book expires in 3 days"
- [ ] Landing page: "Upload 200 photos → AI builds your album in 60 seconds" demo video, 3 example flipbooks, pricing, FAQ
- [ ] Legal pages (mention AI processing), analytics (PostHog), errors (Sentry), AI spend dashboard (sum of `ai_usage` per day)
- [ ] Playwright smoke: login → upload → AI build → edit caption → publish → view → pay (test mode)
- [ ] Stripe live mode when licence is ready → 🚀 launch

## Milestone 10+ — After launch
- [ ] Printing in the UAE (print-shop partner, print-ready PDF, address checkout, Aramex delivery, `/admin/orders`)
- [ ] AI "story mode": a short paragraph per chapter; AI-picked background colours from the photos
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
    api/ai/analyze/  api/ai/plan/  api/ai/captions/  api/ai/rewrite/
    api/geocode/  api/stripe/checkout/  api/stripe/webhook/  api/books/[id]/pdf/  api/cron/cleanup/
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

## Layout definition (`src/lib/layouts/two-vertical.ts`)
```ts
export const twoVertical: Layout = {
  id: "two-vertical",
  name: "2 photos side by side",
  photoCount: 2,
  prefers: ["portrait", "portrait"],      // hint for AI + rule-based fallback
  slots: [ { x: 5, y: 8, w: 43, h: 72 }, { x: 52, y: 8, w: 43, h: 72 } ],   // % of page
  caption: { x: 5, y: 84, w: 90, h: 10 },
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
