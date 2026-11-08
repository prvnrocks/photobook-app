# Progress (newest at the bottom)

Format: `## YYYY-MM-DD — Milestone N — status` then 3–6 bullets: what was built, what's tested, what's left.

## 2026-11-03 — Planning — done
- Product decisions locked (see CLAUDE.md). Plan written in docs/PLAN.md, AI agent design in docs/AI-AGENTS.md.
- Agentic OS set up: hooks log every step to .agentos/logs/, memory in .agentos/memory/, subagents in .claude/agents/.
- NEXT: Milestone 0 (project skeleton). Prerequisites in docs/PLAN.md → "Before you start".

## 2026-11-03 — Milestone 0 — built, awaiting deploy (NEEDS-HUMAN)
- Next.js 15.5.29 + TS + Tailwind v4 + shadcn/ui (v4, base-ui) + ESLint 9 + Vitest 5 + Playwright; Node >=22 required.
- Supabase helpers in src/lib/supabase/ (client, server, admin [server-only], env); PLAN folder tree as .gitkeep/stubs; .env.example (9 keys).
- Landing at src/app/(marketing)/page.tsx: Inter + Cairo + Tajawal, Arabic caption with dir="auto", no overflow at 375px; builds with no env vars.
- Tests: 12 Vitest (cn, .env.example keys, server-only/secret boundaries) + 4 Playwright at 375px — all pass. Reviewer approved, no blockers. Run report: .agentos/runs/m0.md.
- LEFT: user pushes to GitHub, imports into Vercel (Node 22.x/24.x), checks landing on phone → then tick the deploy checkbox in PLAN.md.
- NEXT: Milestone 1 (DB + login). Needs Supabase project + .env.local keys. Carry over reviewer's M1 notes (middleware getUser + two-arg setAll, Database types).

## 2026-11-03 — Milestone 0 — done
- Pushed to github.com/prvnrocks/photobook-app (main). Vercel auto-deploys main; production URL https://photobook-app-alpha.vercel.app/ (public).
- User confirmed on phone: no sideways scroll, Arabic caption RTL in Cairo, button disabled.
- Vercel deployment-hash URLs (*-prvnrocks-projects.vercel.app) are behind Vercel Authentication — share only the production domain.
- NEXT: Milestone 1 (DB + login). User must create Supabase project (eu-central-1 or ap-south-1) and fill .env.local + Vercel env vars.

## 2026-11-08 — Milestone 1 — done
- DB live on hosted Supabase (3 migrations): profiles/books/photos/orders, owner-only RLS, protected book columns (D-011), get_published_book, private photos/exports buckets with `{user_id}/{book_id}/...` paths, hardening (explicit grants, anon none). Live rls_check.sql: 31/31 OK.
- Auth: email link via /auth/confirm (token_hash) + 6-digit code + Google (D-010); middleware session refresh; /login, /dashboard (My books + empty state), /books/new placeholder, sign out. Keys = publishable/secret (D-009).
- Tests: 144 Vitest + 14 Playwright @375px; no secret in client bundle. Reviewer approved; should-fixes applied.
- User confirmed on phone: email link → dashboard, Google → dashboard; 1 user + 1 profile (name null — email signup has no name; header shows email).
- LEFT/CARRY: 6-digit code path not yet tried on phone; custom SMTP (Resend) before real users (built-in ~2 emails/h, team members only); storage cleanup on user delete; Google consent screen "Publish app" before launch; HEIC originals vs PDF (M2).
- NEXT: Milestone 2 (upload + metadata). Needs MAPBOX_TOKEN.

## 2026-11-08 — Milestone 2 — done (place names: open question)
- Upload pipeline live: /books/new (occasion/tone/EN-AR/title) → /books/[id]/upload (one photo at a time, resumable by fingerprint, wake lock, 150/500 cap) → finalize (dup groups, 1 km GPS clusters → Mapbox v6 permanent, fallback album only when doc = {}). 5 migrations applied; live rls_check 61/61.
- Client: EXIF before HEIC, filename/lastModified date fallback, original/web/thumb (HEIC → JPEG), dHash + blur, header size pre-check (>100 MP rejected, >16 MP reduced decode).
- Tests: 587 Vitest + 20 signed-out e2e + 5 live signed-in e2e (upload, resume, cap, guards, finalize 429). Reviewer approved; S1–S8 fixed.
- Phone acceptance (user, iPhone): 110 photos all ready with date (exif), size, hash, blur, 330 files; 17 dup groups (48 photos); album 20 pages. **0 photos had GPS** → place names not exercised on a real phone (pipeline verified with fixtures in e2e). Likely iOS photo picker strips location (or photos had none) — user didn't confirm.
- CARRY to M3: confirm iOS location behaviour; if stripped, add an upload hint ("Options → Location") and make Storyteller work without places; 44% of photos in dup groups looks high — tune thresholds with real photos (Curator decides anyway); decide doc origin marker (rule vs AI) before M3 (reviewer N2, changes D-016 — ask user); add `ai_status 'partial'` if AI-AGENTS.md needs it; AI usage counters server-side only.
- NEXT: Milestone 3 (AI agent pipeline). Needs ANTHROPIC_API_KEY in .env.local + Vercel (Sensitive).
