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
