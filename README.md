# Photobook App

A mobile-first web app for turning your photos into a photobook. Upload photos from your phone,
and AI filters them (drops screenshots, blurry shots and duplicates), groups them into moments, lays
out the album and drafts captions. You tweak anything you like, then share the book as a
**flipbook link** (`/b/[slug]`) or download it as a **PDF**. Launching from Abu Dhabi, UAE; English
UI with Arabic caption support. Free books carry a watermark; a one-time AED 39 upgrade unlocks the full book.

## Setup

Requires **Node 22+**.

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:3000
```

## Checks

```bash
npm run lint && npm run typecheck && npm test   # lint, types, Vitest
npx playwright test                             # smoke tests
```

## Deploy notes (Vercel)

- **PDF export function budget.** `/api/books/[id]/pdf` renders in `after()` for up to 300 s
  (`PDF_MAX_DURATION_SECONDS` in `src/lib/pdf/rules.ts` = the route's `maxDuration` = `vercel.json`;
  the job deadline is 30 s less). Currently sized for **Vercel Hobby with Fluid compute**
  (`"fluid": true` in `vercel.json`): max duration 300 s, fixed 2 GB / 1 vCPU — memory can't be set
  on Hobby, so `vercel.json` sets none. Without Fluid compute Hobby caps at 60 s; then set 60 in the
  three places (only small books fit in 30 s).
- **Hobby is for non-commercial use.** Upgrade to **Pro before taking real payments**. On Pro: keep
  300 s (or raise up to 800 s with Fluid in all three places) and set Dashboard → Settings →
  Functions → Function CPU to **Performance (4 GB / 2 vCPU)**; with Fluid, memory is a project
  setting, not a `vercel.json` key. The render code sizes itself from the function memory
  (≤ 2 GB: 8 print images in flight, ≤ 2 sharp encodes, 1 per vCPU).
- **Expected render time on Hobby (1 vCPU / 2 GB), estimated — not yet measured:** a 40-page book
  took ~12 s server time on an 8-core dev machine (Storage downloads dominate, ~41 images, 3 chunks
  of 20 sheets); on 1 vCPU expect roughly 25–40 s (Chromium print + one sharp encode at a time),
  100 pages roughly 60–100 s — within the 270 s deadline. Re-measure after the first deploy
  (`[pdf-export] timing` log line).
- **Polling** goes to the lightweight `/api/books/[id]/pdf/status` route (no Chromium/sharp in that
  function); a job stuck in `queued` is re-kicked by the client re-POSTing.
- `NEXT_PUBLIC_APP_URL` must be the exact canonical origin (no www/apex redirect) — see `.env.example`.
- Set `preferredRegion` / the project's function region to the Supabase region (every print image
  is downloaded from Storage).

## Docs

- [`docs/PLAN.md`](docs/PLAN.md): milestones and the book document format
- [`docs/AI-AGENTS.md`](docs/AI-AGENTS.md): the in-product AI agent pipeline
- [`CLAUDE.md`](CLAUDE.md): product decisions, stack and architecture rules
