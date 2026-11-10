# Launch checklist

> T16 completes this document. Sections below were added by earlier M9 tasks.

## Legal pages (M9 T12)

**DRAFT — not legal advice — review with a lawyer.**

- `/privacy` and `/terms` (src/app/(marketing)/privacy, terms) are team-written drafts. They show a visible
  "Draft — under legal review" note while `LEGAL_DRAFT = true` in `src/lib/legal/meta.ts`. Flip it to
  `false` only after a lawyer signs off, and update `LEGAL_LAST_UPDATED`.
- NEEDS-HUMAN before launch:
  - `SUPPORT_EMAIL` and `LEGAL_ENTITY_NAME` in `src/lib/brand.ts` (placeholders now).
  - Supabase project region and Resend sending region in `src/lib/legal/processors.ts`.
  - Which data-protection law applies: federal PDPL (Federal Decree-Law No. 45 of 2021) — or ADGM / DIFC
    rules if the company is licensed in a financial free zone. GDPR wording for EU visitors.
  - Refund policy (Terms §Refunds, currently "email within 14 days"), liability cap, governing law and courts.
  - Anthropic training wording ("Under Anthropic's commercial terms, data sent through its API is not used to
    train its models") — check against Anthropic's current commercial terms. Same sentence in the landing FAQ
    (`src/lib/marketing/faq.ts`).
  - Minimum age (18 assumed), cross-border transfer basis.
- Retention text is generated from `retentionSummary()` in `src/lib/cleanup/rules.ts` — change the constants,
  not the page.

## Landing page (M9 T11)

- Hero claim lives in `HERO_CLAIM` / `BUILD_TIME_CLAIM` (`src/lib/marketing/copy.ts`). If live builds take
  longer than about a minute, set `BUILD_TIME_CLAIM = "in minutes"`.
- Demo video: add `public/demo/demo.mp4` + `public/demo/poster.jpg` and redeploy (checked at build time).
- Example flipbooks: fill `EXAMPLE_BOOKS` in `src/lib/marketing/examples.ts` (static covers under `/public`)
  after the demo seed (T15).
