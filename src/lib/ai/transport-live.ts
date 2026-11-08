import "server-only";

// Live transport: one Claude API call per agent step via messages.parse (structured output).
// Never sends thinking/budget_tokens/temperature/top_p/top_k/prefill/tool_choice (400 on Opus 5.5).

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import {
  AI_MODEL,
  AI_TIMEOUT_MS,
  SERVER_FALLBACK_BETA,
  USE_SERVER_FALLBACKS,
  getAnthropic,
} from "./client";
import {
  assertRequestShape,
  TransportError,
  type AgentRequest,
  type AgentResponse,
  type AgentTransport,
  type TokenUsage,
} from "./transport";

type ParseClient = Pick<Anthropic, "messages" | "beta">;

export interface LiveTransportOptions {
  /** Injected for tests; defaults to the lazy getAnthropic() singleton. */
  client?: ParseClient;
  useServerFallbacks?: boolean;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * zodOutputFormat() whose parse() returns null instead of throwing.
 * The SDK's parse throws AnthropicError on invalid JSON / schema mismatch, which would hide
 * stop_reason (refusal, max_tokens leave partial or no JSON). With this wrapper we always get
 * the message back and decide from stop_reason first; parsed_output null → "parse_failed".
 */
export function lenientOutputFormat<T>(schema: z.ZodType<T>) {
  const format = zodOutputFormat(schema);
  return {
    type: format.type,
    schema: format.schema,
    parse(content: string): T | null {
      try {
        return format.parse(content) as T;
      } catch {
        return null;
      }
    },
  };
}

interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function usageFromApi(u: UsageLike | null | undefined): TokenUsage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  };
}

/** Map SDK errors to TransportError. Most specific classes first (subclasses before bases). */
export function toTransportError(e: unknown): TransportError {
  if (e instanceof TransportError) return e;
  const msg = (fallback: string) => (e instanceof Error && e.message ? e.message.slice(0, 300) : fallback);

  if (e instanceof Anthropic.APIConnectionTimeoutError) return new TransportError("timeout", "request timed out");
  if (e instanceof Anthropic.APIConnectionError) return new TransportError("connection", "connection error");
  if (e instanceof Anthropic.APIUserAbortError) {
    return new TransportError("unknown", "request aborted", { retryable: false });
  }
  if (e instanceof Anthropic.RateLimitError) return new TransportError("rate_limited", "rate limited", { status: 429 });
  if (e instanceof Anthropic.InternalServerError) {
    // Includes OverloadedError (529), ServiceUnavailable (503), GatewayTimeout (504).
    return new TransportError("server_error", `server error ${e.status}`, { status: e.status });
  }
  if (e instanceof Anthropic.RequestTimeoutError) return new TransportError("timeout", "request timeout", { status: 408 });
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new TransportError("auth", "authentication / permission error", { status: e.status });
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new TransportError("bad_request", msg("bad request"), { status: 400 });
  }
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === "number" ? e.status : undefined;
    if (status === 429) return new TransportError("rate_limited", "rate limited", { status });
    if (status !== undefined && status >= 500) return new TransportError("server_error", `server error ${status}`, { status });
    if (status !== undefined && status >= 400) return new TransportError("bad_request", `api error ${status}`, { status });
    return new TransportError("unknown", "api error", { status });
  }
  if (e instanceof Error && /api key is not configured/i.test(e.message)) {
    return new TransportError("auth", "no API key configured");
  }
  return new TransportError("unknown", "unexpected transport error");
}

export class LiveTransport implements AgentTransport {
  readonly kind = "live" as const;
  private readonly opts: LiveTransportOptions;

  constructor(opts: LiveTransportOptions = {}) {
    this.opts = opts;
  }

  async parse<T>(req: AgentRequest<T>): Promise<AgentResponse<T>> {
    assertRequestShape(req);
    const now = this.opts.now ?? Date.now;
    const useFallbacks = this.opts.useServerFallbacks ?? USE_SERVER_FALLBACKS;
    const requestOptions = { timeout: this.opts.timeoutMs ?? AI_TIMEOUT_MS };
    const body = {
      model: req.model ?? AI_MODEL,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      output_config: { format: lenientOutputFormat(req.schema), effort: req.effort },
    };

    const t0 = now();
    try {
      const client = this.opts.client ?? getAnthropic();
      const msg = useFallbacks
        ? await client.beta.messages.parse(
            { ...body, betas: [SERVER_FALLBACK_BETA], fallbacks: "default" },
            requestOptions,
          )
        : await client.messages.parse(body, requestOptions);
      return {
        parsed: (msg.parsed_output ?? null) as T | null,
        stopReason: msg.stop_reason ?? null,
        stopCategory: msg.stop_details?.category ?? null,
        usage: usageFromApi(msg.usage),
        model: msg.model,
        latencyMs: Math.max(0, now() - t0),
      };
    } catch (e) {
      throw toTransportError(e);
    }
  }
}
