#!/bin/bash
# Agentic OS memory loader: on SessionStart, injects project memory into Claude's context.
ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
MEM="$ROOT/.agentos/memory"
{
  echo "# AGENTIC OS — PROJECT MEMORY (auto-loaded at session start)"
  echo "Read this before doing anything. Update it with /checkpoint at the end of every milestone or significant step."
  for f in progress.md decisions.md lessons.md; do
    if [ -f "$MEM/$f" ]; then
      echo; echo "----- .agentos/memory/$f -----"
      tail -n 150 "$MEM/$f"
    fi
  done
} | jq -Rs '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: .}}'
exit 0
