// Task 10 (requirement 15): export privacy + storage cleanup, checked against the code and the SQL
// that is actually deployed (migrations are additive; the latest definition wins).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CLEANUP_BUCKETS, OLD_EXPORT_ROW_DAYS, ORPHAN_OBJECT_DAYS, RATE_LIMIT_WINDOW_HOURS } from "@/lib/cleanup/rules";
import { exportObjectPath, exportPackagePath, PRINT_PACKAGE_PARTS } from "@/lib/db/exports";
import { SIGNED_URL_TTL_SECONDS } from "@/lib/pdf/rules";

const MIG = path.join(process.cwd(), "supabase", "migrations");
const migrations = readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(path.join(MIG, f), "utf8"));
/** The latest `create or replace function <name>` body. */
function latestFunction(name: string): string {
  const re = new RegExp(`create or replace function ${name.replace(".", "\\.")}\\(([\\s\\S]*?)\\n\\$\\$;`, "g");
  let last = "";
  for (const sql of migrations) for (const m of sql.matchAll(re)) last = m[0];
  return last;
}

const U = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const E = "33333333-3333-4333-8333-333333333333";

describe("exports: private bucket, short links, owner folder", () => {
  it("the exports bucket is private and clients may only read their own folder", () => {
    const sql = migrations.join("\n");
    expect(sql).toMatch(/'exports',\s*'exports',\s*false,\s*52428800/);
    expect(sql).toMatch(/create policy "exports_select_own" on storage\.objects/);
    expect(sql).not.toMatch(/exports_insert|exports_update|exports_delete_own/);
  });

  it("download links live 10 minutes (PDF and print package)", () => {
    expect(SIGNED_URL_TTL_SECONDS).toBe(600);
    const pkg = readFileSync(path.join(process.cwd(), "src/lib/pdf/package.ts"), "utf8");
    expect(pkg).toMatch(/signExportUrl\(paths\.cover, SIGNED_URL_TTL_SECONDS/);
  });

  it("print package files sit in the owner's book folder next to the PDF", () => {
    expect(exportObjectPath(U, B, E)).toBe(`${U}/${B}/${E}.pdf`);
    expect(PRINT_PACKAGE_PARTS.map((p) => exportPackagePath(U, B, E, p))).toEqual([`${U}/${B}/${E}-cover.pdf`, `${U}/${B}/${E}-interior.pdf`]);
  });
});

describe("cleanup: nothing is kept longer than the rules say", () => {
  it("deleting a book (or account, or the retention sweeps) removes its folder in BOTH buckets", () => {
    expect(CLEANUP_BUCKETS).toEqual(["photos", "exports"]);
    const del = readFileSync(path.join(process.cwd(), "src/lib/cleanup/delete-book.ts"), "utf8");
    expect(del).toMatch(/for \(const bucket of CLEANUP_BUCKETS\)/);
  });

  it("print package files expire: the orphan sweep keeps ONLY {export}.pdf objects of an exports row", () => {
    const fn = latestFunction("public.cleanup_orphan_objects");
    expect(fn).toContain("o.bucket_id = 'exports'");
    expect(fn).toMatch(/\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\\\.pdf\$/);
    expect(fn).toContain("e.path = o.name");
    // the same anchored pattern, applied in JS: package names never match → swept after ORPHAN_OBJECT_DAYS
    const keep = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/([0-9a-f-]{36})\.pdf$/;
    expect(keep.test(exportObjectPath(U, B, E))).toBe(true);
    for (const p of PRINT_PACKAGE_PARTS) expect(keep.test(exportPackagePath(U, B, E, p))).toBe(false);
    expect(ORPHAN_OBJECT_DAYS).toBe(7);
  });

  it("a newer PDF removes the older PDFs and their print packages; failed / superseded rows go after 30 days", () => {
    const job = readFileSync(path.join(process.cwd(), "src/lib/pdf/job.ts"), "utf8");
    expect(job).toMatch(/older\.flatMap\(\(o\) => \[o\.path, \.\.\.PRINT_PACKAGE_PARTS\.map/);
    expect(OLD_EXPORT_ROW_DAYS).toBe(30);
  });

  it("Task 9's rate-limit windows are swept daily", () => {
    expect(RATE_LIMIT_WINDOW_HOURS).toBe(24);
    expect(latestFunction("public.cleanup_rate_limits")).toContain("delete from private.rate_limit_windows");
  });
});

describe("no content in monitoring or print logs", () => {
  it("the monitoring reads select codes, counts, money and timestamps only", () => {
    const src = readFileSync(path.join(process.cwd(), "src/lib/monitoring/summary.ts"), "utf8") + readFileSync(path.join(process.cwd(), "scripts/monitoring-summary.mjs"), "utf8");
    const selects = [...src.matchAll(/\.select\("([^"]+)"\)/g)].map((m) => m[1]!).join(",");
    expect(selects.length).toBeGreaterThan(0);
    for (const col of selects.split(",").map((c) => c.trim())) {
      expect(["operation", "status", "error", "cost_usd", "cost_bucket", "latency_ms", "priced", "created_at", "state", "error_code", "mode", "started_at", "finished_at", "page_count"]).toContain(col);
    }
  });

  it("print package / readiness logs carry codes and counts only", () => {
    for (const f of ["src/lib/pdf/package.ts", "src/lib/print/server.ts", "src/lib/pdf/job.ts"]) {
      const src = readFileSync(path.join(process.cwd(), f), "utf8");
      for (const m of src.matchAll(/console\.(?:info|error|warn|log)\((`[^`]*`|"[^"]*")/g)) {
        expect(m[1]!, f).not.toMatch(/\$\{(?:book|user|title|path|url|doc|caption)/i);
      }
    }
  });
});
