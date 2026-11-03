#!/bin/bash
# Agentic OS logger: appends one JSON line per Claude Code event to .agentos/logs/YYYY-MM-DD.jsonl
# Receives the hook payload as JSON on stdin. Prints nothing to stdout (so it never pollutes context).
ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LOG_DIR="$ROOT/.agentos/logs"
mkdir -p "$LOG_DIR"
jq -c --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  def short: walk(if type == "string" and length > 400 then .[0:400] + "…[truncated]" else . end);
  {
    ts: $ts,
    event: .hook_event_name,
    session: .session_id,
    agent: (.agent_type // "main"),
    tool: .tool_name,
    input: (.tool_input // null | short),
    prompt: (.prompt // null | if . == null then null else .[0:2000] end),
    error: (.error // null | if . == null then null else tostring[0:1000] end),
    source: (.source // .trigger // null),
    last_message: (.last_assistant_message // null | if . == null then null else tostring[0:1500] end)
  } | with_entries(select(.value != null))
' >> "$LOG_DIR/$(date +%Y-%m-%d).jsonl" 2>/dev/null
exit 0
