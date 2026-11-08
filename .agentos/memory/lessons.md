# Lessons learned (newest at the bottom)

Things that went wrong or surprised us, so no agent repeats them. Format: `- (YYYY-MM-DD, area) lesson`.

- (2026-11-03, images) Read EXIF with exifr BEFORE converting HEIC → JPEG; conversion strips EXIF.
- (2026-11-03, images) Photos received via WhatsApp usually have no EXIF; fall back to file.lastModified.
- (2026-11-03, claude-api) Opus 5.5: no thinking:disabled, no budget_tokens, no temperature, no prefill, no forced tool_choice — all 400.
- (2026-11-03, tooling) create-next-app refuses non-empty dirs: scaffold in scratchpad, copy in, merge .gitignore (scaffold's `.env*` would ignore .env.example).
- (2026-11-03, tooling) shadcn v4 init = base-ui (no `asChild`; use `render` prop or buttonVariants on <Link>) and may write a circular `--font-sans: var(--font-sans)` — check globals.css after init.
- (2026-11-03, tooling) Vitest 5 + `cn` need Node >=22 and @types/node >=22.
- (2026-11-03, next) After deleting a route file, `tsc --noEmit` fails on stale .next/types until `next build`/dev regenerates them.
- (2026-11-03, next) A stray ~/package-lock.json makes Next infer the wrong workspace root — `outputFileTracingRoot` is pinned in next.config.ts.
- (2026-11-03, agents) Never let agents move/delete .env* files; a builder tried `mv .env.local /dev/null` in a compound command (blocked by permissions).
- (2026-11-03, vercel) Deployment-hash URLs are protected by Vercel Authentication by default; public links must use the production domain (or a custom domain). Matters for /b/[slug] share links and OG previews.
- (2026-11-08, supabase) `npx supabase login/link/db push` need a real TTY — run them in the user's own Terminal, not via Claude Code's `!` prefix. Afterwards the saved login lets agents run `migration list --linked` / `gen types --linked`.
- (2026-11-08, supabase) Pin the CLI to 2.x (npm `latest` is 3.x). `supabase init` 2.122's default additional_redirect_urls (https://127.0.0.1:3000) is wrong for local http.
- (2026-11-08, supabase) Email template must be `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` (+ `{{ .Token }}`) in BOTH Magic Link and Confirm signup. `{{ .RedirectTo }}?token_hash` breaks because emailRedirectTo already contains `?next=`. A link ending in `?code=` pointing at localhost = Site URL still localhost + default template.
- (2026-11-08, supabase) Column-guard trigger checking `current_user` must be SECURITY INVOKER (under DEFINER current_user = owner → everyone passes). Any future postgres-owned DEFINER function bypasses the guard.
- (2026-11-08, supabase) After revoking table grants from anon, anon gets "permission denied" instead of 0 rows; live checks must accept insufficient_privilege and also assert has_table_privilege.
- (2026-11-08, supabase) `supabase gen types` types RETURNS TABLE columns as non-null even when NULL is possible — wrap such RPCs in src/lib/db with corrected types.
- (2026-11-08, supabase) Built-in SMTP: ~2 emails/hour, only to project team members → "Too many attempts" quickly while testing. Google provider must be enabled in Supabase or OAuth returns "Unsupported provider: provider is not enabled".
- (2026-11-08, next) A "use server" file may only export async functions — keep useActionState state types/initial state in a separate module. Next's route announcer has role="alert" → target error banners by testid.
- (2026-11-08, vercel) Preview deployments also run with NODE_ENV=production — NEXT_PUBLIC_APP_URL must be set for Preview too, or sign-in fails there.
- (2026-11-08, testing) PGlite + ~20 lines of Supabase stubs can dry-run migrations and RLS scripts without Docker (scripts were in session scratchpad, not in repo).
