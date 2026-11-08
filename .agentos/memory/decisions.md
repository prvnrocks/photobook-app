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
