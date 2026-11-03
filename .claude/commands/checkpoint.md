---
description: Save progress to project memory (progress, decisions, lessons) and tick PLAN.md checkboxes
argument-hint: [optional note]
---
Update the Agentic OS memory so the next session can continue without re-discovering anything. Extra note: $ARGUMENTS

1. Append to `.agentos/memory/progress.md` a dated entry: milestone, status, what was built, tests status, what's next.
2. For every non-obvious choice made since the last checkpoint, append a `D-NNN` entry to `.agentos/memory/decisions.md`
   (continue numbering; Decision / Why / Alternatives rejected).
3. Append new one-line lessons to `.agentos/memory/lessons.md` (from HANDOFF "lesson?" lines and test failures).
4. Tick the completed checkboxes in docs/PLAN.md.
5. Keep each memory file under ~300 lines: if longer, summarise the oldest entries into a "## Archive summary" section.
6. If inside a git repo, commit the memory + plan changes: `chore(memory): checkpoint`.
Report which files you changed in 3–5 lines.
