# M11 Wave B — common brief for every frontend builder

The user SIGNED OFF the style board (docs/design/m11-style-board-*.png, /dev-style). Roll the look out to your screens only.

Read first: CLAUDE.md, .agentos/memory/lessons.md, D-067, the full plan in .agentos/runs/m11.md (your task rows + "Ground rules" + "Risks" + the list of exact strings specs assert), and the foundation:
src/app/globals.css (tokens, type-* utilities, shadows, max-w-app/wide), src/components/ui/button.tsx (sizes touch/cta, variant accent — accent at most once per screen), src/components/app/* (PageHeader, StepProgress, Notice, EmptyState, LoadingState, Skeleton/PageSkeleton, ActionBar, AppToast), src/lib/app/flow-steps.ts.

Rules:
- Edit ONLY the files in your task rows (+ new files you create for them, + tests for them). Four other builders edit other files in this same tree at the same time. If typecheck/lint/test errors appear in files that are not yours, they belong to another builder — ignore them, mention them in your HANDOFF. NEVER git stash, never revert others' changes, do not commit.
- Never edit src/components/book/**, src/components/print/**, src/lib/layouts/**, src/lib/design/**, viewer Flipbook/FlipPage/EndCard, globals.css, button.tsx, src/components/app/* (if a shared component needs a change, describe it in HANDOFF instead), next/font configs.
- Keep every data-testid, every analytics track() call and ?_ev= flash, every exact asserted string listed in the plan (if a spec/test must change, update it and list it). dir="auto" on user text (titles, captions); logical spacing (ms/me/ps/pe).
- 375 px: no sideways scroll; tap targets ≥ 44 px; visible focus; AA contrast; use tokens, not raw amber-50/red-50 etc.
- Copy states only what the server confirmed; AI drafts / user decides.
- Unit tests for changed components (update existing copy tests where you change copy on purpose).
- Screenshots: docs/design/m11-<area>-375.png and -1280.png for each screen you change. Use dev fixtures (/dev-editor?sample=, /dev-viewer?sample=, /dev-publish, /dev-upgrade) where possible; for signed-in pages you may use a pinned scratch copy (git archive HEAD + your files, symlink node_modules/.env.local/supabase/.temp) on a port other than 3000 with a throwaway e2e user on the live DB via the existing e2e helpers — clean up everything incl. orphan agent_runs; never open /books/[id]/build with a fresh load unless you want a run (it starts one); AI_MODE=replay, empty ANTHROPIC_API_KEY, never call cron, never print secrets. LOOK at your screenshots and iterate until they match the style board.
- Checks before HANDOFF: npm run lint && npm run typecheck && npm test (note others' failures separately); tests/golden/* pass with no GOLDEN_UPDATE.
- End with HANDOFF: files changed, strings/testids/specs touched, screenshots, checks, requests for shared components, lesson?.
