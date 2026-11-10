import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Keys from docs/PLAN.md -> "Before you start" -> `.env.local` keys, plus AI_MODE (D-024) and
// ADMIN_USER_IDS (D-027) added in M3, BOOK_ACCESS_SECRET (D-040) added in M6,
// STRIPE_ALLOW_TEST_IN_PROD (M7 review: test keys refused on Vercel Production unless 1).
const REQUIRED_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "ANTHROPIC_API_KEY",
  "AI_MODE",
  "ADMIN_USER_IDS",
  "MAPBOX_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_ALLOW_TEST_IN_PROD",
  "NEXT_PUBLIC_APP_URL",
  "CRON_SECRET",
  "BOOK_ACCESS_SECRET",
];

function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    expect(eq, `malformed line: ${line}`).toBeGreaterThan(0);
    const key = line.slice(0, eq).trim();
    expect(out.has(key), `duplicate key ${key}`).toBe(false);
    out.set(key, line.slice(eq + 1).trim());
  }
  return out;
}

describe(".env.example", () => {
  const env = parseEnv(readFileSync(join(process.cwd(), ".env.example"), "utf8"));

  it("contains exactly the 13 expected keys", () => {
    expect([...env.keys()].sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it("has empty values (no secrets committed)", () => {
    for (const [key, value] of env) {
      expect(value, `${key} should be empty`).toBe("");
    }
  });
});
