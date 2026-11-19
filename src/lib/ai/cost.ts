// Cost of one call in USD. Anthropic usage.input_tokens excludes cache tokens, so the four
// buckets are additive.
//
// Prices come from src/lib/ai/pricing.ts (defaults + AI_PRICING_JSON, Task 9). Unknown models
// (e.g. the model a server-side refusal fallback answered with, or a renamed model) are priced
// CONSERVATIVELY: each bucket at the most expensive rate of any known model, and reported as
// `priced: false` by costOf() so the usage ledger flags them. Logged costs may then over-state,
// never under-state, spend — limits and cost dashboards stay safe.

import { lookupPrice, type ModelPrice } from "./pricing";
import type { TokenUsage } from "./transport";

export function priceFor(model: string): ModelPrice {
  return lookupPrice(model).price;
}

/** True when `model` has a configured price (defaults or AI_PRICING_JSON). */
export function isPriced(model: string): boolean {
  return lookupPrice(model).priced;
}

const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

/** Cost in USD and whether the model had a price (false = highest known rate was used). */
export function costOf(model: string, usage: TokenUsage): { usd: number; priced: boolean } {
  const { price: p, priced } = lookupPrice(model);
  const usd = (n(usage.input) * p.input + n(usage.output) * p.output + n(usage.cacheRead) * p.cacheRead + n(usage.cacheWrite) * p.cacheWrite) / 1_000_000;
  return { usd: Math.round(usd * 1e6) / 1e6, priced };
}

export function costUsd(model: string, usage: TokenUsage): number {
  return costOf(model, usage).usd;
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
  const usd = (n(call.inputTokens) * Math.max(p.input, p.cacheWrite) + n(call.maxOutputTokens) * p.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
