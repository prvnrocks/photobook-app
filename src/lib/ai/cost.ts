// Cost of one call in USD. Anthropic usage.input_tokens excludes cache tokens, so the four
// buckets are additive. Unknown models are priced as AI_MODEL (logged costs stay non-zero).

import { AI_MODEL, PRICING } from "./client";
import type { TokenUsage } from "./transport";

export function priceFor(model: string) {
  return PRICING[model] ?? PRICING[AI_MODEL];
}

export function costUsd(model: string, usage: TokenUsage): number {
  const p = priceFor(model);
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const usd =
    (n(usage.input) * p.input +
      n(usage.output) * p.output +
      n(usage.cacheRead) * p.cacheRead +
      n(usage.cacheWrite) * p.cacheWrite) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}
