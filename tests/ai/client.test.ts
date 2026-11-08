import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AI_MODEL,
  CURATOR_CONCURRENCY,
  EFFORT,
  PRICING,
  USE_SERVER_FALLBACKS,
  getAnthropic,
  hasApiKey,
  resolveAiMode,
} from "@/lib/ai/client";

const KEY = "sk-ant-test-not-real";

describe("resolveAiMode (D-024)", () => {
  it.each([
    // [label, env, expected]
    ["local, no key → replay", {}, "replay"],
    ["preview, no key → replay", { VERCEL_ENV: "preview", NODE_ENV: "production" }, "replay"],
    ["production, no key → off", { VERCEL_ENV: "production" }, "off"],
    ["local, key → live", { ANTHROPIC_API_KEY: KEY }, "live"],
    ["production, key → live", { VERCEL_ENV: "production", ANTHROPIC_API_KEY: KEY }, "live"],
    ["whitespace key counts as missing", { ANTHROPIC_API_KEY: "   " }, "replay"],
    ["AI_MODE=off wins over key", { AI_MODE: "off", ANTHROPIC_API_KEY: KEY }, "off"],
    ["AI_MODE=replay wins over key", { AI_MODE: "replay", ANTHROPIC_API_KEY: KEY }, "replay"],
    ["AI_MODE=replay allowed in production", { AI_MODE: "replay", VERCEL_ENV: "production" }, "replay"],
    ["AI_MODE=live with key", { AI_MODE: "live", ANTHROPIC_API_KEY: KEY }, "live"],
    ["AI_MODE=live without key, production → off", { AI_MODE: "live", VERCEL_ENV: "production" }, "off"],
    ["AI_MODE=live without key, preview → replay", { AI_MODE: "live", VERCEL_ENV: "preview" }, "replay"],
    ["AI_MODE is case/space-insensitive", { AI_MODE: " OFF " }, "off"],
    ["invalid AI_MODE = auto", { AI_MODE: "turbo", VERCEL_ENV: "production" }, "off"],
    ["empty AI_MODE = auto", { AI_MODE: "", ANTHROPIC_API_KEY: KEY }, "live"],
    ["NODE_ENV=production alone is not production", { NODE_ENV: "production" }, "replay"],
  ] as const)("%s", (_label, env, expected) => {
    expect(resolveAiMode(env as Record<string, string>)).toBe(expected);
  });

  it("hasApiKey never needs the value", () => {
    expect(hasApiKey({})).toBe(false);
    expect(hasApiKey({ ANTHROPIC_API_KEY: KEY })).toBe(true);
  });
});

describe("constants", () => {
  it("model, pricing, effort, concurrency", () => {
    expect(AI_MODEL).toBe("claude-opus-5-5");
    expect(PRICING[AI_MODEL]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(EFFORT.curator).toBe("low");
    expect(EFFORT.storyteller).toBe("medium");
    expect(EFFORT.caption_writer).toBe("medium");
    expect(EFFORT.rewriter).toBe("low");
    expect(CURATOR_CONCURRENCY).toBe(5);
    expect(USE_SERVER_FALLBACKS).toBe(true);
  });
});

describe("getAnthropic", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws a clear error without a key (no network)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => getAnthropic()).toThrow(/API key is not configured/);
  });
});
