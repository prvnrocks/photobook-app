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

## Docs

- [`docs/PLAN.md`](docs/PLAN.md): milestones and the book document format
- [`docs/AI-AGENTS.md`](docs/AI-AGENTS.md): the in-product AI agent pipeline
- [`CLAUDE.md`](CLAUDE.md): product decisions, stack and architecture rules
