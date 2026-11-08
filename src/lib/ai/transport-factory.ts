import "server-only";

// Picks the transport for the current AI mode (D-024). `null` = AI off → rule-based album.

import { resolveAiMode, type AiMode } from "./client";
import type { AgentTransport } from "./transport";
import { LiveTransport } from "./transport-live";
import { ReplayTransport } from "./transport-replay";
import "./agents/replay-synths"; // registers replay synthesisers (curator, ...)

export function getTransport(mode: AiMode = resolveAiMode()): AgentTransport | null {
  if (mode === "live") return new LiveTransport();
  if (mode === "replay") return new ReplayTransport();
  return null;
}
