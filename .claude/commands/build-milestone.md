---
description: Run one milestone end-to-end through the Agentic OS (plan → build → test → review → checkpoint)
argument-hint: <milestone number, e.g. 3>
---
You are the ORCHESTRATOR. Build Milestone $ARGUMENTS from docs/PLAN.md using the specialist subagents.

1. **Recall** — the project memory was auto-loaded at session start; re-read .agentos/memory/progress.md and
   lessons.md if needed. If Milestone $ARGUMENTS depends on an unfinished milestone, stop and say so.
2. **Plan** — delegate to the `planner` agent. Show me the task list and wait for my OK before building.
3. **Branch** — `git checkout -b m$ARGUMENTS-<short-name>` (git init first if there is no repo).
4. **Build** — for each task in dependency order, delegate to its owner agent (frontend-builder, backend-builder,
   ai-pipeline-builder) with: the task, relevant files, and the HANDOFF notes from earlier tasks. Run independent
   tasks in parallel. After each HANDOFF, append a short entry to `.agentos/runs/m$ARGUMENTS.md`
   (task, agent, files, checks, notes).
5. **Test** — delegate to `tester`. If FAIL: send bugs back to the owning builder, then re-test (max 3 loops,
   then stop and ask me).
6. **Review** — delegate to `reviewer`. Fix BLOCKERs via the owning builder, re-review.
7. **Checkpoint** — run the /checkpoint steps: update progress.md, add decisions and lessons, tick the
   checkboxes in docs/PLAN.md, commit with message `M$ARGUMENTS: <summary>`.
8. **Report** — tell me in plain language what now works, what I must check on my phone (NEEDS-HUMAN items),
   and what's next.
