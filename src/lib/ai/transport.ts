// Transport abstraction for agent calls: live (Claude API) or replay (fixtures / synthesised).
// Pure types + helpers, no SDK import — agents and runAgentStep depend only on this.

import type { z } from "zod";

export const AGENTS = [
  "curator",
  "storyteller",
  "caption_writer",
  "critic",
  "rewriter",
  "memory_keeper",
] as const;
export type AgentName = (typeof AGENTS)[number];

/** Effort levels we allow (xhigh/max are not used in-product: cost/latency). */
export type Effort = "low" | "medium" | "high";

/** Max images per request (CLAUDE.md AI rules). */
export const MAX_IMAGES_PER_REQUEST = 10;

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp"; data: string };
    };

/**
 * User turns only: assistant prefill returns 400 on Opus 5.5, so the type does not allow it.
 */
export interface AgentMessage {
  role: "user";
  content: string | ContentPart[];
}

export interface AgentRequest<T> {
  agent: AgentName;
  /** Stable, byte-identical across calls (no timestamps/ids) so the prefix caches. */
  system: SystemBlock[];
  messages: AgentMessage[];
  /** AI-facing (lean) zod schema sent as output_config.format. Re-validate with a strict one. */
  schema: z.ZodType<T>;
  effort: Effort;
  maxTokens: number;
  /** Override AI_MODEL for this step. */
  model?: string;
  /**
   * Replay only (never sent to the API): data a replay synthesiser needs to build a
   * schema-valid answer, e.g. `{ aliases: ["p1","p2"] }`, and an optional `fixtureName`.
   */
  scenarioMeta?: Record<string, unknown>;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_USAGE: TokenUsage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export interface AgentResponse<T> {
  /** null when the output did not parse / match the AI schema (or on refusal / max_tokens). */
  parsed: T | null;
  stopReason: string | null;
  /** stop_details.category on refusals. */
  stopCategory?: string | null;
  usage: TokenUsage;
  /** Model that actually answered (may differ from the request when a server fallback ran). */
  model: string;
  latencyMs: number;
}

export interface AgentTransport {
  readonly kind: "live" | "replay";
  parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>>;
}

export type TransportErrorCode =
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "connection"
  | "bad_request"
  | "auth"
  | "unknown";

const RETRYABLE: Record<TransportErrorCode, boolean> = {
  rate_limited: true,
  server_error: true,
  timeout: true,
  connection: true,
  bad_request: false,
  auth: false,
  unknown: false,
};

/** Typed transport failure. `message` never contains prompt or photo content. */
export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(code: TransportErrorCode, message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE[code];
    this.status = opts.status;
  }
}

export function isTransportError(e: unknown): e is TransportError {
  return e instanceof TransportError;
}

/** One cached system block (cache_control on the last — here only — block). */
export function cachedSystem(text: string): SystemBlock[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

export function countImages(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const p of m.content) if (p.type === "image") n++;
  }
  return n;
}

/** Programmer-error guard shared by both transports. */
export function assertRequestShape(req: AgentRequest<unknown>): void {
  if (countImages(req.messages) > MAX_IMAGES_PER_REQUEST) {
    throw new TransportError("bad_request", `more than ${MAX_IMAGES_PER_REQUEST} images in one request`);
  }
  if (req.messages.length === 0) throw new TransportError("bad_request", "no messages");
  if (!Number.isInteger(req.maxTokens) || req.maxTokens <= 0) {
    throw new TransportError("bad_request", "maxTokens must be a positive integer");
  }
}
