import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { isPaymentsEnabled, stripeKeyMode } = await import("@/lib/stripe");

afterEach(() => vi.unstubAllEnvs());

function env(over: Record<string, string>) {
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("STRIPE_ALLOW_TEST_IN_PROD", "");
  for (const [k, v] of Object.entries(over)) vi.stubEnv(k, v);
}

describe("stripeKeyMode", () => {
  it.each([
    ["sk_live_abc", "live"],
    ["rk_live_abc", "live"],
    ["  sk_live_abc  ", "live"],
    ["sk_test_abc", "test"],
    ["rk_test_abc", "test"],
    ["", "test"],
    ["live_sk_abc", "test"],
  ])("%s → %s", (key, mode) => {
    env({ STRIPE_SECRET_KEY: key });
    expect(stripeKeyMode()).toBe(mode);
  });
});

describe("isPaymentsEnabled", () => {
  it("needs both the secret key and the webhook secret", () => {
    env({ STRIPE_SECRET_KEY: "sk_test_x" });
    expect(isPaymentsEnabled()).toBe(false);
    env({ STRIPE_WEBHOOK_SECRET: "whsec_x" });
    expect(isPaymentsEnabled()).toBe(false);
    env({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" });
    expect(isPaymentsEnabled()).toBe(true);
  });

  it("test key is fine outside Vercel Production (local, preview)", () => {
    env({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", VERCEL_ENV: "preview" });
    expect(isPaymentsEnabled()).toBe(true);
  });

  it("Vercel Production refuses a test key", () => {
    env({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", VERCEL_ENV: "production" });
    expect(isPaymentsEnabled()).toBe(false);
  });

  it.each(["0", "true", "yes", ""])("STRIPE_ALLOW_TEST_IN_PROD=%j does not override", (v) => {
    env({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      VERCEL_ENV: "production",
      STRIPE_ALLOW_TEST_IN_PROD: v,
    });
    expect(isPaymentsEnabled()).toBe(false);
  });

  it("STRIPE_ALLOW_TEST_IN_PROD=1 allows a test key in Production", () => {
    env({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      VERCEL_ENV: "production",
      STRIPE_ALLOW_TEST_IN_PROD: "1",
    });
    expect(isPaymentsEnabled()).toBe(true);
  });

  it.each(["sk_live_x", "rk_live_x"])("Vercel Production with %s → enabled", (key) => {
    env({ STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: "whsec_x", VERCEL_ENV: "production" });
    expect(isPaymentsEnabled()).toBe(true);
  });
});
