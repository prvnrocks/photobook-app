# Agentic OS — how this project builds itself

```
            YOU  ──/build-milestone 3──▶  ORCHESTRATOR (main Claude Code session)
                                              │  reads MEMORY (auto-loaded at start)
              ┌──────────────┬────────────────┼─────────────────┬──────────────┐
              ▼              ▼                ▼                 ▼              ▼
          planner    frontend-builder  backend-builder  ai-pipeline-builder   tester ──▶ reviewer
          (tasks)        (UI)          (DB/API/Stripe)     (Claude agents)    (tests)    (approve)
              └──────────────┴──── HANDOFF notes ─┴─────────────────┴──────────────┘
                                              │
                                    /checkpoint → MEMORY updated, PLAN ticked, git commit
   every prompt / tool call / delegation / failure ──hooks──▶ LOGS (.agentos/logs/*.jsonl)
```

| Part | Where | What |
|---|---|---|
| Agents | `.claude/agents/*.md` | 6 specialists with their own tools and rules |
| Orchestration | `.claude/commands/*.md` | `/build-milestone N`, `/checkpoint`, `/status`, `/log-decision` |
| Memory | `.agentos/memory/` | `progress.md` (where we are), `decisions.md` (why), `lessons.md` (don't repeat mistakes) |
| Logs | `.agentos/logs/YYYY-MM-DD.jsonl` | every event, auto-written by hooks in `.claude/settings.json` |
| Run reports | `.agentos/runs/mN.md` | per-milestone task-by-task record of handoffs, tests, review |
| Timeline | `.agentos/bin/timeline.sh [date] [lines]` | human-readable view of the logs |

Useful log queries:
```bash
.agentos/bin/timeline.sh                                   # today's activity
jq -r 'select(.event=="PostToolUseFailure")' .agentos/logs/*.jsonl   # all failures
jq -r 'select(.tool=="Write" or .tool=="Edit") | .input.file_path' .agentos/logs/*.jsonl | sort | uniq -c | sort -rn  # most-edited files
jq -r '.agent' .agentos/logs/*.jsonl | sort | uniq -c       # activity per agent
```
