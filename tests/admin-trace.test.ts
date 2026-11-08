// T14 — /admin/runs/[id] (D-027): admin allow-list parsing, trace formatting,
// and server/client boundaries for ADMIN_USER_IDS.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isAdminUser } from "@/lib/auth/is-admin";
import {
  costMismatch,
  formatDuration,
  formatUsd,
  prettyTraceJson,
  sumStepCosts,
} from "@/lib/admin/trace-format";

const A = "11111111-2222-4333-8444-555555555555";
const B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("isAdminUser", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ADMIN_USER_IDS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = saved;
  });

  it("missing or empty env → nobody is admin", () => {
    delete process.env.ADMIN_USER_IDS;
    expect(isAdminUser(A)).toBe(false);
    process.env.ADMIN_USER_IDS = "";
    expect(isAdminUser(A)).toBe(false);
    process.env.ADMIN_USER_IDS = " , ,";
    expect(isAdminUser(A)).toBe(false);
  });

  it("null / undefined / non-uuid user ids are never admin", () => {
    process.env.ADMIN_USER_IDS = A;
    expect(isAdminUser(null)).toBe(false);
    expect(isAdminUser(undefined)).toBe(false);
    expect(isAdminUser("")).toBe(false);
    expect(isAdminUser("not-a-uuid")).toBe(false);
  });

  it("matches trimmed entries, case-insensitively", () => {
    process.env.ADMIN_USER_IDS = `  ${B.toUpperCase()} ,\t${A}  `;
    expect(isAdminUser(A)).toBe(true);
    expect(isAdminUser(B)).toBe(true);
    expect(isAdminUser("99999999-2222-4333-8444-555555555555")).toBe(false);
  });

  it("ignores invalid entries (no wildcard, no partial match)", () => {
    process.env.ADMIN_USER_IDS = `*,${A.slice(0, 8)},true,${A}x`;
    expect(isAdminUser(A)).toBe(false);
    process.env.ADMIN_USER_IDS = `garbage, ${A}`;
    expect(isAdminUser(A)).toBe(true);
  });

  it("re-reads the env on every call", () => {
    process.env.ADMIN_USER_IDS = A;
    expect(isAdminUser(A)).toBe(true);
    process.env.ADMIN_USER_IDS = B;
    expect(isAdminUser(A)).toBe(false);
  });
});

describe("trace formatting", () => {
  it("formats cost with 4 decimals", () => {
    expect(formatUsd(0.01234)).toBe("$0.0123");
    expect(formatUsd("1.5")).toBe("$1.5000");
    expect(formatUsd(null)).toBe("$0.0000");
  });

  it("sums step costs and flags mismatches beyond rounding", () => {
    const sum = sumStepCosts([{ cost_usd: 0.01 }, { cost_usd: 0.00234 }, { cost_usd: null }]);
    expect(sum).toBe(0.0123);
    expect(costMismatch(0.0123, sum)).toBe(false);
    expect(costMismatch("0.0123", sum)).toBe(false);
    expect(costMismatch(0.0125, sum)).toBe(true);
    expect(costMismatch(0, 0)).toBe(false);
  });

  it("formats durations", () => {
    const t0 = "2026-11-08T10:00:00.000Z";
    expect(formatDuration(t0, null)).toBe("running");
    expect(formatDuration(t0, "2026-11-08T10:00:00.850Z")).toBe("850 ms");
    expect(formatDuration(t0, "2026-11-08T10:00:12.300Z")).toBe("12.3 s");
    expect(formatDuration(t0, "2026-11-08T10:04:05.000Z")).toBe("4m 05s");
  });

  it("redacts URL-like strings from logged JSON (no photo links, D-027)", () => {
    const out = prettyTraceJson({
      ids: ["p1"],
      thumb: "https://x.supabase.co/storage/v1/object/sign/photos/a.jpg?token=t",
      inline: "data:image/jpeg;base64,AAAA",
      nested: [{ u: " blob:http://localhost/123" }],
      reason: "blurry",
    });
    expect(out).not.toMatch(/https?:|data:|blob:/);
    expect(out).toContain('"reason": "blurry"');
    expect(out.match(/\[url redacted\]/g)).toHaveLength(3);
    expect(prettyTraceJson(null)).toBe("null");
  });
});

// --- boundaries ---------------------------------------------------------------

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) ? [p] : [];
  });
}
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

function hasUseClientDirective(source: string): boolean {
  const stripped = source
    .replace(/^\uFEFF/, "")
    .replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return /^["']use client["']\s*;?/.test(stripped);
}

describe("admin boundaries (T14)", () => {
  it('src/lib/auth/is-admin.ts starts with import "server-only"', () => {
    const first = readFileSync(join(SRC, "lib", "auth", "is-admin.ts"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim() !== "");
    expect(first?.trim()).toMatch(/^import ["']server-only["'];?$/);
  });

  it("process.env.ADMIN_USER_IDS is only read in src/lib/auth/is-admin.ts", () => {
    // Comments elsewhere may name the variable; reading it is what matters.
    const READ = /process\.env(\.ADMIN_USER_IDS\b|\[\s*["']ADMIN_USER_IDS["']\s*\])|\{[^}]*\bADMIN_USER_IDS\b[^}]*\}\s*=\s*process\.env/;
    const matches = walk(SRC)
      .filter((f) => READ.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(matches).toEqual(["src/lib/auth/is-admin.ts"]);
  });

  it('no "use client" file imports is-admin or the trace page helpers that need it', () => {
    const offenders = walk(SRC)
      .filter((f) => hasUseClientDirective(readFileSync(f, "utf8")))
      .filter((f) => /["'](@\/lib\/auth\/is-admin|(\.\.?\/)+[^"']*auth\/is-admin)["']/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("the admin trace page 404s non-admins before loading the trace", () => {
    const page = readFileSync(join(SRC, "app", "admin", "runs", "[id]", "page.tsx"), "utf8");
    expect(hasUseClientDirective(page)).toBe(false);
    const guard = page.indexOf("isAdminUser(user.id)) notFound()");
    const load = page.indexOf("await getRunTrace(");
    expect(guard).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(guard);
    expect(page).not.toMatch(/redirect\(/);
    expect(page).not.toMatch(/<img|next\/image|signedUrl|thumb_path|web_path/i);
  });
});
