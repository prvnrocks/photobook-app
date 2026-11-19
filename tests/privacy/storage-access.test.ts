// Task 9 privacy: uploaded photos and exports are private by default and only ever reachable through
// short-lived signed URLs made on the server (static checks over migrations + src).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CLEANUP_BUCKETS } from "@/lib/cleanup/rules";
import { COVER_THUMB_TTL_SECONDS } from "@/lib/db/books";
import { EDITOR_URL_TTL_SECONDS } from "@/lib/db/editor";
import { bookPrefix } from "@/lib/db/cleanup";
import { exportObjectPath } from "@/lib/db/exports";
import { REVIEW_URL_TTL_SECONDS } from "@/lib/db/photos";
import { VIEWER_URL_TTL_SECONDS } from "@/lib/db/public-books";
import { SIGNED_URL_TTL_SECONDS } from "@/lib/pdf/rules";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n")
  .replace(/--.*$/gm, "");

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? srcFiles(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const SRC = srcFiles(join(process.cwd(), "src"));

describe("privacy: storage is private by default (Task 9)", () => {
  it("both buckets are created private and no migration ever makes a bucket public", () => {
    expect(sql).toMatch(/'photos',\s*'photos',\s*false/);
    expect(sql).toMatch(/'exports',\s*'exports',\s*false/);
    expect(sql).not.toMatch(/update\s+storage\.buckets\s+set[^;]*public\s*=\s*true/i);
    expect(sql).not.toMatch(/'(photos|exports)',\s*'\w+',\s*true/);
  });

  it("every storage.objects policy is for signed-in users and scoped to their own top folder", () => {
    const policies = [...sql.matchAll(/create policy "[^"]+" on storage\.objects([\s\S]*?);/g)].map((m) => m[1]!);
    expect(policies.length).toBeGreaterThanOrEqual(5);
    for (const p of policies) {
      expect(p).toMatch(/to authenticated/);
      expect(p).not.toMatch(/to (anon|public)/);
      expect(p).toContain("(storage.foldername(name))[1] = (select auth.uid())::text");
    }
  });

  it("no public URL is ever made; signed URLs are made only in server-only modules", () => {
    expect(SRC.filter((f) => readFileSync(f, "utf8").includes("getPublicUrl(")).map((f) => relative(process.cwd(), f))).toEqual([]);
    const signers = SRC.filter((f) => /createSignedUrls?\(/.test(readFileSync(f, "utf8")));
    expect(signers.length).toBeGreaterThan(0);
    for (const f of signers) expect(readFileSync(f, "utf8").startsWith('import "server-only";'), relative(process.cwd(), f)).toBe(true);
  });

  it("signed URLs are short-lived: owner views ≤ 1 h, downloads / review ≤ 10 min, the public viewer ≤ 6 h", () => {
    expect(EDITOR_URL_TTL_SECONDS).toBeLessThanOrEqual(3600);
    expect(REVIEW_URL_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(COVER_THUMB_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(VIEWER_URL_TTL_SECONDS).toBeLessThanOrEqual(6 * 3600);
    // literal TTLs passed to createSignedUrl(path, n) stay small too
    for (const f of SRC) {
      for (const m of readFileSync(f, "utf8").matchAll(/createSignedUrl\([^,]+,\s*(\d+)\)/g)) expect(Number(m[1]), relative(process.cwd(), f)).toBeLessThanOrEqual(600);
    }
  });

  it("every object of a book lives under {user}/{book}/ in a bucket the book deletion sweeps", () => {
    const user = "11111111-1111-4111-8111-111111111111";
    const book = "22222222-2222-4222-8222-222222222222";
    expect(bookPrefix(user, book)).toBe(`${user}/${book}/`);
    expect(exportObjectPath(user, book, "33333333-3333-4333-8333-333333333333").startsWith(bookPrefix(user, book))).toBe(true);
    const buckets = [...sql.matchAll(/\(\s*'(\w+)',\s*'\w+',\s*(?:true|false)/g)].map((m) => m[1]);
    expect([...CLEANUP_BUCKETS].sort()).toEqual([...new Set(buckets)].sort());
  });
});
