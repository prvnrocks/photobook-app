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
