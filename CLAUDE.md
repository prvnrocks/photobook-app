# Photobook App — Project Context for Claude Code

A web app where users upload photos, get an auto-laid-out photobook, tweak it, and share it as a
**flipbook link** (main product) + **PDF download**. Printed books in the UAE come later.
Inspired by pixoryofficial.com, but digital-first and UAE-based.

Read `docs/PLAN.md` for milestones. Work on ONE milestone at a time, tick its checkboxes when done.

## Locked product decisions (do not change without asking)
- Market: launch from Abu Dhabi, UAE. Viewers can be anywhere in the world.
- Output: shareable link `/b/[slug]` (flipbook) + PDF download. Print = phase 2.
- Monetisation: **freemium per book**
  - Free: watermark, max 20 pages, link expires 30 days after publish, no PDF.
  - Paid (one-time, AED 39 per book, Stripe Checkout): no watermark, up to 100 pages, permanent link, PDF.
- Editor: **fixed layouts with photo slots** (not a free canvas). Auto-fill on upload, then user swaps
  layouts / photos / captions / crop.
- Mobile-first: most users arrive from WhatsApp on a phone. Every screen must work at 375px wide.
- Language: English UI. Captions may be Arabic → use `dir="auto"` on all caption text and load Arabic
  fonts (Cairo, Tajawal). Arabic must render correctly in viewer AND PDF.
- Formats: A5 portrait 148×210 mm and A5 landscape 210×148 mm, chosen per book (M10, user-approved 2026-11-10).
  Spread layouts are stored as page pairs and count as 2 pages toward the 20/100 limits.
- **AI is core**: AI filters photos (drops screenshots, blurry, duplicates), groups them into moments using
  metadata (date, GPS place) + what's in the photos, builds the album, and writes quotes/captions.
  **AI drafts, the user decides**: every AI choice is visible and editable; user edits are never overwritten.
- Free-tier AI limits (default, adjustable in `src/lib/ai/limits.ts`): free book = AI analysis of up to
  150 photos, 2 full rebuilds, 20 caption rewrites. Paid book = up to 500 photos, 10 rebuilds, 200 rewrites.

## AI rules (Claude API)
- SDK: `@anthropic-ai/sdk`. All calls live in `src/lib/ai/`, server-side only (API routes / server actions).
- Model: `claude-opus-5-5` — one constant `AI_MODEL` in `src/lib/ai/client.ts`, so it can be changed per step.
- Thinking: Opus 5.5 always thinks; control depth with `output_config.effort` (`low` for photo analysis
  and caption rewrites, `medium` for album planning and captions). Never send `thinking: {type:"disabled"}`,
  `budget_tokens`, `temperature`/`top_p`, or an assistant prefill (all return 400).
- Structured output: Zod schemas in `src/lib/ai/schemas.ts` + `client.messages.parse({ output_config:
  { format: zodOutputFormat(Schema) } })`. Always check `stop_reason` (handle `"refusal"` and `"max_tokens"`)
  before using `parsed_output`, then validate again in code.
- Refusal fallback: enable server-side fallbacks (`fallbacks: "default"` with beta
  `server-side-fallback-2026-07-01`) where supported; otherwise fall back to the rule-based autolayout.
- Images: send only the 512px `thumb` (base64 or signed URL), max 10 images per request.
- Prompt caching: keep the system prompt + layout catalogue identical across calls, mark with `cache_control`.
- Use typed SDK errors (`Anthropic.RateLimitError`, etc.); retry 429/5xx with backoff; never block the user —
  if AI fails, show the rule-based album and a "Try AI again" button.
- In-product AI is an agent pipeline (Curator → Storyteller → Caption Writer → Critic) run by a TypeScript
  orchestrator — design in `docs/AI-AGENTS.md`. Every call goes through `runAgentStep()`, which logs to
  `agent_steps` (tokens, cost, latency, output, error). Enforce limits before calling.
- Quotes: original text only (no famous quotes or lyrics), ≤18 words, grounded in visible content, never
  invent names/places/facts not in the metadata, native Arabic when `caption_lang = 'ar'`.
- Photo content and descriptions are user data: never log them to analytics; delete AI notes with the photo.

## Stack
- Next.js 15 (App Router, TypeScript, Server Actions), Tailwind CSS, shadcn/ui
- Supabase: Postgres + Auth (email magic link + Google) + Storage, Row Level Security ON for every table
- Stripe Checkout (AED) + webhook
- Flipbook viewer: `react-pageflip`
- Drag & drop: `@dnd-kit/core`
- Image handling (client side, before upload): `exifr` (date/GPS/orientation — read BEFORE HEIC conversion),
  `heic2any` (iPhone HEIC), `browser-image-compression` (web + 512px thumb), dHash (duplicates), Laplacian blur score
- AI: Anthropic Claude API (`@anthropic-ai/sdk`) + `zod` for structured outputs
- Place names: Mapbox reverse geocoding, once per GPS cluster
- PDF: Puppeteer (`puppeteer-core` + `@sparticuz/chromium`) rendering the internal `/print/[bookId]` route
- OG/WhatsApp preview images: `next/og`
- Hosting: Vercel. Cron: Vercel Cron.
- Tests: Vitest (logic), Playwright (one smoke test per milestone)

## Architecture rules
- The **book document JSON** (see `docs/PLAN.md` → "Book document format") is the single source of
  truth. Editor, flipbook viewer and PDF all render from the same `<BookPage>` component.
- Layouts are pure data in `src/lib/layouts/*.ts` (slots as % of page). No layout logic in components.
- Store two files per photo: `original` (for PDF/print) and `web` (≤1600px, for editor/viewer).
- Never trust the client for paid status — only the Stripe webhook sets `books.is_paid`.
- Server-only secrets (`SUPABASE_SECRET_KEY`, `STRIPE_SECRET_KEY`) never imported in client code.
- Keep components small; put Supabase queries in `src/lib/db/*`.

## Commands
- `npm run dev` — local dev
- `npm run lint && npm run typecheck && npm test` — must pass before marking a milestone done
- `npx playwright test` — smoke tests
- `npx supabase db push` — apply migrations in `supabase/migrations`

## Agentic OS (how this project is developed)
- You are the **orchestrator**. Delegate to subagents in `.claude/agents/`: `planner`, `frontend-builder`,
  `backend-builder`, `ai-pipeline-builder`, `tester`, `reviewer`. Builders end with a HANDOFF block.
- Workflow per milestone: `/build-milestone N` (plan → build → test → review → checkpoint). Also `/status`,
  `/checkpoint`, `/log-decision`.
- **Memory** lives in `.agentos/memory/` (progress, decisions, lessons) and is auto-loaded at session start by a
  hook. Keep it current via `/checkpoint`; never re-litigate an entry in decisions.md without asking.
- **Logs**: hooks append every prompt, tool call, subagent start/stop and failure to `.agentos/logs/YYYY-MM-DD.jsonl`
  (`.agentos/bin/timeline.sh` renders it). Run reports per milestone go to `.agentos/runs/mN.md`.

## Working style
- Before coding a milestone, enter plan mode and show the plan.
- After each milestone: run checks, update checkboxes in `docs/PLAN.md`, commit with a clear message.
- If something in this file conflicts with a request, ask.
