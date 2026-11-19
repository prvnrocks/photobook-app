# AI Balanced Storybook — release notes, open risks, deployment checklist (Tasks 1–10)

Branch chain: Task 1 … Task 10 are stacked commits ending on `story-export-readiness` (not pushed, not
deployed). Everything below was verified with unit / component tests, replayed AI (no live model calls), the
local PDF pipeline with a local Chrome, and dev-route Playwright at 375 px. **No signed-in end-to-end round and
no live AI call has been made for Tasks 5–10** — that round comes next (see the checklist).

Nothing here is a print-provider certification. The PDF is checked against our own **digital A5 spec**
(`generic-a5-digital`, read from the renderer's constants). UAE / India print partners exist only as
placeholder specs with every number `null` until a real provider specification is in hand.

---

## 1. What was built

| Task | What | Main code | Migration |
| --- | --- | --- | --- |
| 1 | Storybook foundation: zod schemas (PhotoAnalysis, MemoryContext, Moment, Chapter, NarrativeBlock, StoryPage, Storybook), 65 % photo / 35 % narrative balance, immutable versions with merge rules | `src/lib/storybook` | 2200 `storybooks`, `storybook_versions` |
| 2 | Photo ingestion: server-side verification of stored originals (magic bytes, size, pixels), metadata-free 512 px AI copies (EXIF/GPS/XMP stripped), ingest status | `src/lib/photos/ingest*.ts` | 2300 `photo_ingest` |
| 3 | Photo Intelligence: `analyzePhoto()` — one vision call per photo, cached by image hash + model + prompt version, limits, retries, cost log | `src/lib/ai/photo-intelligence` | 2400 `photo_analyses` |
| 4 | Photo organiser: quality scores (sharpness / exposure / composition), exact + near duplicate groups, moment clustering by time / GPS / content (no deletions) | `src/lib/photos/{quality,duplicates,moments,organize}.ts` | 2500 `photo_quality`, `photo_duplicate_groups`, `photo_moments` |
| 5 | Wizard re-ordered (Title, Occasion, Photos, Story, Design, Create, Preview); story questions per occasion; memory context; design recommendation; birthday occasion | `src/components/wizard`, `src/lib/story` | — |
| 6 | Story Planner + Narrative Writer: `planStory`, `writeStory`, `rewriteNarrativeBlock`; grounding check (no invented names / places / dates / speech; EN + AR); page skeleton keeps the balance; per-book story limits | `src/lib/ai/story` | 2600 `story_ai_calls` |
| 7 | Page composer: page texts in the doc (v2), 5 template families × 6 styles × 2 formats, deterministic composition with overflow / crop / DPI rules, one AI page-intent call (approved ids only), user edits kept on re-compose, editor Text tool | `src/lib/storybook/compose`, `src/lib/ai/story/compose.ts`, `src/lib/layouts/story` | 2700 (compose kind) |
| 8 | Storybook generation job: resumable ticks with a DB lease, four real stages (discovering → organizing → writing → designing), Stop / Try again / resume, wizard step 6, editor Story actions | `src/lib/ai/story/run.ts`, `src/app/api/ai/story-runs` | 2800 (agent_runs trigger `storybook`) |
| 9 | Privacy + metering: per-attempt usage ledger, configurable pricing, spending caps, Postgres rate limits, entitlement abstraction + admin grants, 4–6 page free preview + "Complete my book", revocable share links, privacy page + `docs/PRIVACY-DATA.md`, log-redaction guard (D-092…D-096) | `src/lib/ai/usage`, `src/lib/entitlements`, `src/lib/http/rate-limit.ts` | 2900 (ledger, totals, entitlements, limiter) |
| 10 | Export + print readiness + monitoring (this task, section 2) | `src/lib/print`, `src/lib/pdf`, `src/lib/monitoring` | none |

## 2. Task 10 in detail

**Digital PDF from the StorybookDocument.** The book doc JSON (doc + `meta.story`, page texts) stays the single
source. The M8 pipeline is reused unchanged in shape: POST `/api/books/[id]/pdf` → export row (doc snapshot) →
`runExport` (print-size images with sharp at 300 dpi, EXIF stripped; Chromium on `/print/[bookId]` behind a
5-minute HMAC header token; 154×216 / 216×154 mm sheets; static OFL fonts so nothing becomes Type3; ≤ 20-sheet
chunks merged with pdf-lib with TrimBox / BleedBox) → private `exports` bucket → 10-minute signed URL.

New in Task 10:
- **Print spec abstraction** `src/lib/print/specs`: `PrintSpec` (trim per format, bleed, safe margin, target /
  minimum effective dpi, colour handling in words, fonts embedded, interior page min / max / multiple, cover
  layout + spine formula, `providerVerified`, `todo`). `generic-a5-digital` is derived from the renderer's own
  constants (BLEED_MM 3, SAFE_MM 4, 300 dpi plan, 150 dpi warning, front cover only). `uae-pod-placeholder` and
  `india-pod-placeholder` have every number `null` and "TODO fill from provider spec".
- **`validatePrintReadiness(doc, spec, ctx)`** (`src/lib/print/readiness.ts`): per-sheet issues. Errors
  (block the PDF, route answers **422 `not_ready`** with plain lines): spec incomplete, format unsupported, page
  count out of range, **blank page**, **missing photo**, **story text that overflows its panel** (the composer's
  own fitter), **text box inside the safe margin**. Warnings (never block, D-037): **low effective dpi** (with the
  number), empty photo slot, cover title that may clip, text that only just fits.
- **Shown before export**: share page PDF card shows "Checks passed for digital A5 PDF" / "…with N notes" /
  "N things to fix before the PDF can be made" + up to 8 lines (`PrintChecks`, server-rendered, 375 px). The
  editor's PDF control shows the same lines when POST answers `not_ready`.
- **PDF verification after rendering**: the merged PDF must have exactly cover + one sheet per page
  (`page_count_mismatch`) and no sheet without a single painting operator (`blank_page`, `mergePdfs().blankPages`).
- **Cover and interior separately**: "Get print files" on the share page → POST `/api/books/[id]/pdf/package` →
  cover PDF (1 page) + inside-pages PDF cut from the ready export of the current saved doc (same render, so they
  match the combined PDF exactly; print boxes, fonts and images copied as they are). Paid books only
  (`canExportPdf` = `is_paid`; a grant never unlocks it), rate-limited, 10-minute signed URLs, files expire.
- **Progress + errors**: the checklist (request → waiting → making pages → ready) shows real server states only
  (no percentages). Failed jobs now say what happened in plain words ("took too long", "came out too big", "one of
  the photos couldn't be read", "a page didn't come out right") and keep **Try again**.
- **Honest copy**: "print-ready PDF" removed from the PDF card, the editor tool and the landing marquee ("High-
  quality PDF"). A test keeps "print-ready" / "certified" out of every readiness line.
- **Grant page limit** (Task 9 gap): a granted (non-Stripe) full storybook composes up to the paid page limit —
  `resolveEntitlement` gives grants 100 pages, `grantBookEntitlement` raises `books.max_pages`, the job calls
  `ensureGrantPageLimit` before planning (older grants). PDF / watermark / permanent link stay `is_paid`-only.
  Revoking returns to 20 only when the book still fits.
- **Cleanup**: the daily cron sweeps Task 9's rate-limit windows (`cleanup_rate_limits(24)`); a newer PDF removes
  older PDFs **and** their print packages; print package files are orphans by design (no row path) → removed
  7 days after they were made; book / account deletion removes the whole `{user}/{book}/` folder in both buckets.
- **Monitoring**: `/admin/monitoring` (+ `/api/admin/monitoring`, `scripts/monitoring-summary.mjs`) — AI attempt
  failure / refusal / retry rates per operation, storybook stage times per model call and whole-run p50 / p95,
  live AI cost per Dubai day by bucket, export failure codes and request → ready p50 / p95; daily
  `[monitor] alert=<code> value=<n>` lines from the cron. Admin-only (404 otherwise), numbers and codes only.
- **Future print-on-demand (UAE / India)** without a printer API: fill one `PrintSpec` from the partner's
  document; `validatePrintReadiness` already checks any complete spec; the print package already gives cover +
  interior files. Still needed then: a cover wrap renderer (back + spine + front, spine width from the partner's
  formula and paper), colour conversion / output intent if the partner requires CMYK / PDF/X, and an order
  adapter. None of this is assumed or faked now.

### Verified by (Task 10)
- `tests/print/readiness.test.ts` — specs, every single-page / cover layout inside the 4 mm safe margin, all 6
  styles × 2 formats × EN/AR composed storybooks without errors, blank / missing / low-dpi / overflow / page count,
  placeholder specs never pass, copy honesty.
- `tests/print/storybook-fixtures.test.ts` — **10, 20, 40, 60-photo** storybooks and **missing metadata,
  duplicates, low-resolution** books through organise → plan → write (replay) → compose (replay intent + rule
  fallback) → readiness → `<PrintDocument>` markup; chapter order kept, no photo twice, duplicates never both
  printed, no invented dates / places without metadata; **user edits (page text, crop, photo swap, title) survive**
  into the export snapshot and the print markup, and survive a re-compose.
- `tests/print-fixtures.live.test.ts` (local Chrome + `next dev`) — real `renderChunk` + `mergePdfs` + split,
  inspected with `scripts/pdf-inspect.mjs` (numbers in section 5 of the hand-off; summary below).
- `tests/print/renderer-parity.test.tsx` — edit / view / print show the same texts and photos.
- `tests/print/package.test.ts`, `tests/print/privacy-cleanup.test.ts`, `tests/task10-grant-pages.test.ts`,
  `tests/task10-monitoring.test.ts`, updated `pdf-*` / `cleanup-run` / `cron-route` / `story-run` tests,
  `e2e/task10-print-checks.spec.ts` (375 px, dev fixture).

Local PDF render (2026-11-19, local Chrome via `PDF_CHROME_PATH`, synthetic print-size images):

| Fixture | Sheets | Trim / bleed (mm) | Fonts | dpi min / median |
| --- | --- | --- | --- | --- |
| 10 photos, classic, portrait | 10 (cover + 9) | 148×210 / 154×216 | 2, all embedded, no Type3 | 169 / 300 |
| 20 photos, magazine, landscape, user edits | 15 (cover + 14) | 210×148 / 216×154 | 3, all embedded, no Type3 | 171 / 300 |
| 40 photos, editorial, portrait, user edits | 30 (cover + 29) | 148×210 / 154×216 | 4, all embedded, no Type3 | 195 / 300 |
| 60 photos, modern, landscape, low-res every 3rd | 38 (cover + 37) | 210×148 / 216×154 | 7, all embedded, no Type3 | 99 / 300 (16 low-dpi warnings, not blocking) |
| 20 photos, scrapbook, portrait, Arabic | 16 (cover + 15) | 148×210 / 154×216 | 2 (Amiri, Lalezar), embedded, no Type3 | 221 / 300 |

## 3. Unresolved risks (collected from Tasks 1–10)

AI quality / cost
- **Live AI cost and latency are unmeasured** for the storybook pipeline (photo analysis on Sonnet + plan / write /
  compose on Opus). All Task 3–10 numbers come from replay. The only live data point is the classic album
  (~$0.10–0.13 for 12 photos, M30). Measure one 40- and one 100-photo storybook before pricing is final.
- **Model prices and Anthropic retention are not verified** (`src/lib/ai/pricing.ts` defaults, `AI_PRICING_JSON`;
  retention days and commercial terms — `docs/PRIVACY-DATA.md` "VERIFY BEFORE LAUNCH"); Supabase backup / PITR
  days and Mapbox retention likewise.
- **Haiku is not enabled** (`claude-haiku-5-5`): price and effort / fallback support unverified (D-095).
- **Grounding blind spot for Arabic names**: the grounding check compares names / places in the text with the
  user's facts as written; transliterated or differently spelled Arabic names (and Latin ↔ Arabic script) can pass
  or be rejected wrongly.
  Needs a native-reader review of live Arabic output.
- **Balance drift**: the 65 / 35 photo / narrative split is held by the skeleton and composer geometry; user edits,
  dropped blocks (grounding failures) and overflow moves can drift a book away from it — it is reported, not
  enforced.
- Synthetic e2e photos make the live Curator keep 1 of 12 — a live quality sample needs real photos.

Layout / print
- **`ed-p-cover` Arabic title clipping**: long Arabic titles on the editorial portrait cover can clip at the
  fitter's minimum size. Task 10 flags `title_may_clip` (warning) when the estimate says so; the estimate is
  approximate and has not been proven against every Arabic face.
- The PDF is **RGB, no ICC output intent, no PDF/X**, front cover only (no back cover / spine / wrap). Fine for the
  digital product; a print partner will very likely need more. Not certified against any provider.
- Emoji in captions render as boxes in the PDF (M8 backlog). Worst-case 100-page noisy panorama books can exceed
  50 MB even after the size fallback (M10b).
- `blank_page` detection checks for at least one painting operator; a sheet that paints only an invisible shape
  would pass. Doc-level blank detection runs first.

Flow / platform
- **Preview → "Complete my book" flow has no end-to-end test** (unit only); the Task 5 story-wizard e2e was never
  run to completion; **no signed-in e2e has been run for Tasks 5–10**.
- **Tick > lease risk**: a storybook tick (route `maxDuration` 300 s) that runs a slow write close to the lease
  length can lose its lease mid-step; the next tick redoes the step (idempotent, costs one more model call).
  Measure tick times live.
- Rate limiter and spending caps fail **open** if the DB function is unreachable (by design).
- Vercel Hobby is non-commercial and keeps logs ~1 h — Pro before real payments (D-053) and for log-based alerting.
- Print package generation downloads the stored PDF into memory (≤ 50 MB) inside a 60 s function — fine for normal
  books, untested at the 50 MB edge on Vercel.
- Monitoring reads at most 20 000 rows per table per window (`row_cap_reached` note) — fine for launch scale.

## 4. Deployment checklist

Migrations (hosted DB): **2100 → 2900 are already applied. Task 10 adds none.** Verify with
`npx supabase migration list --linked` (local and remote columns identical up to `20261124002900`). Do not run
`db push` for Task 10.

1. **Merge order**: the stacked branch as one fast-forward to `main` (Tasks 1–10 together; Task 9 code expects 2900,
   already applied).
2. **Env vars** (Vercel Production; Preview with test values) — see `.env.example`:
   - AI: `ANTHROPIC_API_KEY`, `AI_MODE` (unset/live in Production, `replay` on Preview), `AI_DAILY_BUDGET_USD`,
     `AI_STORY_MODEL` (default `claude-opus-5-5`), `AI_PHOTO_MODEL` (default `claude-sonnet-5-5`),
     `AI_PHOTO_CONCURRENCY` / `_TIMEOUT_MS` / `_MAX_RETRIES`, `AI_STORY_TIMEOUT_MS` / `_MAX_RETRIES`.
   - Cost controls (Task 9): `AI_PRICING_JSON` (only if the defaults are wrong — verify prices first),
     `AI_CAP_BOOK_PREVIEW_USD`, `AI_CAP_BOOK_FULL_USD`, `AI_CAP_USER_DAY_USD`, `AI_CAP_USER_MONTH_USD`,
     `AI_PREVIEW_PAGES` (4–6), `AI_PREVIEW_MAX_RUNS`, `RATE_LIMIT_SECRET` (`openssl rand -base64 32`).
   - Platform: `ADMIN_USER_IDS` (gates `/admin/monitoring` too), `CRON_SECRET`, `BOOK_ACCESS_SECRET` (≥ 32 bytes, print
     tokens), `NEXT_PUBLIC_APP_URL` (exact canonical origin — the PDF renderer opens `/print` there),
     `VERCEL_AUTOMATION_BYPASS_SECRET` (Preview PDFs), Stripe keys, Resend, Sentry, PostHog, `MAPBOX_TOKEN` (invalid
     today — replace).
3. **Vercel functions**: Fluid compute ON; `/api/books/*/pdf` 300 s (vercel.json + route + `PDF_MAX_DURATION_SECONDS`);
   story / album tick routes 300 s; cron 300 s; `/pdf/package` 60 s; function region next to Supabase; Pro + Function
   CPU Performance before real payments.
4. **Stripe webhook**: live endpoint `<prod>/api/stripe/webhook` with the 6 events in `docs/LAUNCH.md` §1.3; only the
   webhook (and `comp_book`) sets `is_paid`.
5. **Cron**: `0 1 * * *` → after the first run, one `[cleanup] <sweep>` line per sweep incl. `rate_limits`, then
   `[monitor] daily …`; alerts as `[monitor] alert=<code>` (RUNBOOK §4.1).
6. **rls_check**: SQL editor → `supabase/tests/rls_check.sql` → **`RLS OK — all 190 checks passed`** (unchanged by Task 10).
7. **Signed-in e2e round** (Preview with replay, then one live): wizard → storybook job (all four stages) → editor
   (Text tool, change photo, regenerate page) → publish (free preview caps at the preview pages; revoke link) →
   upgrade (test payment) → "Complete my book" → Download PDF → print files; a granted book composes past 20 pages and
   still has no PDF. Also `e2e/task5-story-wizard.spec.ts`, which was never finished.
8. **One live AI storybook** with real photos (40 photos, then 100): record cost per book on `/admin/monitoring`
   (cost per day by bucket) and stage times; check Arabic grounding with a native reader.
9. **Phone checks (375 px)**: wizard story / design steps, step 6 progress + Stop, editor preview banner, share page
   print checks + PDF + print files on iPhone (Files / Preview) and Android, Arabic text in the PDF, WhatsApp link
   preview of a storybook.
10. **Before launch**: verify model prices, Anthropic retention / terms, Supabase PITR days, Mapbox retention
    (`docs/PRIVACY-DATA.md`); lawyer review of `/privacy` + `/terms`.
