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
