// Cost of one call in USD. Anthropic usage.input_tokens excludes cache tokens, so the four
// buckets are additive.
//
// Unknown models (e.g. the model a server-side refusal fallback answered with, or a renamed model)
// are priced CONSERVATIVELY: each bucket at the most expensive rate of any known model. Logged
// costs may then over-state, never under-state, spend — limits and cost dashboards stay safe.
// Add the real price to PRICING in client.ts when a new model shows up in agent_steps.model.

import { PRICING } from "./client";
import type { TokenUsage } from "./transport";

type Price = (typeof PRICING)[string];

const MAX_KNOWN_PRICE: Price = Object.values(PRICING).reduce<Price>(
  (m, p) => ({
    input: Math.max(m.input, p.input),
    output: Math.max(m.output, p.output),
    cacheRead: Math.max(m.cacheRead, p.cacheRead),
    cacheWrite: Math.max(m.cacheWrite, p.cacheWrite),
  }),
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
);

export function priceFor(model: string): Price {
  return Object.prototype.hasOwnProperty.call(PRICING, model) ? PRICING[model] : MAX_KNOWN_PRICE;
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

/**
 * Pessimistic cost of a call that has not happened yet (D-035 run budget): every input token at
 * the higher of the input / cache-write rate, plus the FULL output budget (maxTokens, incl.
 * thinking) at the output rate. Real calls cost less (cache reads, shorter answers).
 */
export function estimateCallCostUsd(model: string, call: { inputTokens: number; maxOutputTokens: number }): number {
  const p = priceFor(model);
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const usd = (n(call.inputTokens) * Math.max(p.input, p.cacheWrite) + n(call.maxOutputTokens) * p.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
