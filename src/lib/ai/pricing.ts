// Model pricing (Task 9): a defaults table + an optional override from the environment, so a price
// change or a new model never needs a code change. Pure (env is a parameter) and secret-free.
//
//   AI_PRICING_JSON   JSON object, model id → { input, output, cacheRead?, cacheWrite? } in USD per
//                     million tokens. Rows are MERGED over the defaults (a row replaces that model's
//                     defaults; other models keep theirs). cacheRead defaults to 0.1 × input and
//                     cacheWrite (5-minute TTL) to 1.25 × input when omitted.
//                     Example: {"claude-haiku-5-5":{"input":1,"output":5}}
//
// An invalid AI_PRICING_JSON is IGNORED as a whole (defaults only) and reported in `error` — a typo
// must never zero out prices. A model with no price anywhere is "unpriced": its calls are costed at
// the most expensive known rate (over-states, never under-states spend) and flagged `priced: false`
// in the usage ledger, so the gap is visible instead of silently $0.

import { z } from "zod";

export type ModelPrice = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * USD per million tokens. Sources: the prices this project has used since M3 (CLAUDE.md model
 * `claude-opus-5-5`; `claude-sonnet-5-5` added in Task 3). Verify against the Anthropic pricing page
 * before launch; correct them with AI_PRICING_JSON without a deploy.
 *
 * NOT listed on purpose: `claude-haiku-5-5`. Its price could not be verified from the repository
 * or the SDK, so it is not invented here (TODO before enabling it for photo descriptions — see
 * photo-intelligence/config.ts). Any call answered by a model without a price is recorded as
 * unpriced (costed at the highest known rate) until AI_PRICING_JSON gives it one.
 */
export const DEFAULT_PRICING: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
});

const usd = z.number().finite().min(0).max(1000);
const PriceRowSchema = z.strictObject({ input: usd, output: usd, cacheRead: usd.optional(), cacheWrite: usd.optional() });
export const PricingOverrideSchema = z.record(z.string().regex(/^[a-z0-9][a-z0-9.\-]{0,63}$/), PriceRowSchema).refine((r) => Object.keys(r).length <= 50, { message: "too many models" });

export type PricingTable = { prices: Readonly<Record<string, ModelPrice>>; error: "invalid_json" | "invalid_shape" | null };

type Env = Record<string, string | undefined>;

/** The effective pricing table for `env` (defaults merged with AI_PRICING_JSON). */
export function readPricing(env: Env = process.env): PricingTable {
  const raw = (env.AI_PRICING_JSON ?? "").trim();
  if (!raw) return { prices: DEFAULT_PRICING, error: null };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { prices: DEFAULT_PRICING, error: "invalid_json" };
  }
  const parsed = PricingOverrideSchema.safeParse(json);
  if (!parsed.success) return { prices: DEFAULT_PRICING, error: "invalid_shape" };
  const prices: Record<string, ModelPrice> = { ...DEFAULT_PRICING };
  for (const [model, p] of Object.entries(parsed.data)) {
    prices[model] = { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input * 0.1, cacheWrite: p.cacheWrite ?? p.input * 1.25 };
  }
  return { prices: Object.freeze(prices), error: null };
}

let memo: { raw: string | undefined; table: PricingTable } | null = null;

/** readPricing(process.env), re-parsed only when AI_PRICING_JSON changes. */
export function currentPricing(): PricingTable {
  const raw = process.env.AI_PRICING_JSON;
  if (!memo || memo.raw !== raw) memo = { raw, table: readPricing(process.env) };
  return memo.table;
}

/** The highest rate of each bucket over every priced model (the unpriced fallback). */
export function maxKnownPrice(prices: Readonly<Record<string, ModelPrice>>): ModelPrice {
  return Object.values(prices).reduce<ModelPrice>(
    (m, p) => ({ input: Math.max(m.input, p.input), output: Math.max(m.output, p.output), cacheRead: Math.max(m.cacheRead, p.cacheRead), cacheWrite: Math.max(m.cacheWrite, p.cacheWrite) }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}

/** The price of `model`, and whether it has one (false = costed at the highest known rate). */
export function lookupPrice(model: string, prices: Readonly<Record<string, ModelPrice>> = currentPricing().prices): { price: ModelPrice; priced: boolean } {
  if (Object.prototype.hasOwnProperty.call(prices, model)) return { price: prices[model]!, priced: true };
  return { price: maxKnownPrice(prices), priced: false };
}
