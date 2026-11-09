import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PRICING } from "@/lib/ai/client";
import { addUsage, costUsd, estimateCallCostUsd } from "@/lib/ai/cost";

const M = "claude-opus-5-5";

describe("costUsd", () => {
  it("prices input and output", () => {
    expect(costUsd(M, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(4);
    expect(costUsd(M, { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBe(20);
  });

  it("prices cache reads at $0.20/MTok and 5-minute cache writes at $5/MTok", () => {
    expect(costUsd(M, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 })).toBe(0.2);
    expect(costUsd(M, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 })).toBe(5);
  });

  it("adds all four buckets (a typical curator batch)", () => {
    // 3 500 input + 2 000 cache read + 600 output: 0.014 + 0.0004 + 0.012
    expect(costUsd(M, { input: 3500, output: 600, cacheRead: 2000, cacheWrite: 0 })).toBeCloseTo(0.0264, 6);
  });

  it("is zero for zero usage and ignores negative / NaN", () => {
    expect(costUsd(M, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
    expect(costUsd(M, { input: -5, output: Number.NaN, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });

  it("prices unknown models (e.g. a server fallback) at the most expensive known rate", () => {
    const u = { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 };
    const max = Object.values(PRICING).reduce(
      (m, p) => ({ input: Math.max(m.input, p.input), output: Math.max(m.output, p.output), cacheRead: Math.max(m.cacheRead, p.cacheRead), cacheWrite: Math.max(m.cacheWrite, p.cacheWrite) }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    const expected = Math.round(((max.input + max.output + max.cacheRead + max.cacheWrite) * 1000) / 1_000_000 * 1e6) / 1e6;
    expect(costUsd("some-fallback-model", u)).toBe(expected);
    expect(costUsd("some-fallback-model", u)).toBeGreaterThanOrEqual(costUsd(M, u));
    expect(costUsd("__proto__", u)).toBe(expected);
  });

  it("addUsage sums buckets", () => {
    expect(
      addUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }),
    ).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  });
});

describe("estimateCallCostUsd (D-035)", () => {
  it("prices all input at the cache-write rate and the full output budget", () => {
    // 10k input × $5/M + 8k output × $20/M
    expect(estimateCallCostUsd(M, { inputTokens: 10_000, maxOutputTokens: 8_000 })).toBeCloseTo(0.05 + 0.16, 6);
  });

  it("is never below the real cost of a call within that budget", () => {
    const real = costUsd(M, { input: 4_000, output: 8_000, cacheRead: 3_000, cacheWrite: 3_000 });
    expect(estimateCallCostUsd(M, { inputTokens: 10_000, maxOutputTokens: 8_000 })).toBeGreaterThanOrEqual(real);
  });

  it("unknown models use the most expensive known prices; bad numbers count as 0", () => {
    expect(estimateCallCostUsd("future-model", { inputTokens: 1_000_000, maxOutputTokens: 0 })).toBe(5);
    expect(estimateCallCostUsd(M, { inputTokens: Number.NaN, maxOutputTokens: -1 })).toBe(0);
  });
});
