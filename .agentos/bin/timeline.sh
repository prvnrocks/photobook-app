#!/bin/bash
# Human-readable timeline of what the agents did. Usage: .agentos/bin/timeline.sh [YYYY-MM-DD] [lines]
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DAY="${1:-$(date +%Y-%m-%d)}"; N="${2:-80}"
FILE="$ROOT/.agentos/logs/$DAY.jsonl"
[ -f "$FILE" ] || { echo "No log for $DAY"; exit 0; }
jq -r '
  [ .ts[11:19], .agent, .event,
    ( if .tool == "Bash" then "$ " + (.input.command // "")
      elif (.tool == "Write" or .tool == "Edit") then .tool + " " + (.input.file_path // "")
      elif .tool == "Agent" then "→ delegate to " + (.input.subagent_type // "?") + ": " + (.input.description // "")
      elif .tool then .tool
      elif .prompt then "USER: " + (.prompt | gsub("\n"; " ") | .[0:120])
      elif .error then "ERROR: " + .error
      else (.source // "") end ) ]
  | @tsv' "$FILE" | tail -n "$N" | column -t -s $'\t' | cut -c1-200
