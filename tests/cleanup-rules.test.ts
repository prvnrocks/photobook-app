import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FREE_LINK_DAYS } from "@/lib/publish/rules";
import {
  CLEANUP_BATCH,
  CLEANUP_BUCKETS,
  CRON_TIME_BUDGET_MS,
  DRAFT_IDLE_DAYS,
  DRAFT_NOTICE_DAYS,
  DRAFT_WARNING_DAYS,
  EXPIRY_WARNING_DAYS_BEFORE,
  FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY,
  OLD_EXPORT_ROW_DAYS,
  ORPHAN_OBJECT_DAYS,
  PENDING_UPLOAD_DAYS,
  STALE_AGENT_RUN_HOURS,
  STORAGE_REMOVE_MAX,
  UNLOCK_ATTEMPT_HOURS,
  WARNING_KINDS,
  draftDeleteAfter,
  freeBookDeleteAfter,
  retentionSummary,
} from "@/lib/cleanup/rules";

const DAY = 86_400_000;
const src = readFileSync(join(process.cwd(), "src", "lib", "cleanup", "rules.ts"), "utf8");
const migration = readFileSync(join(process.cwd(), "supabase", "migrations", "20261114001600_cleanup.sql"), "utf8");

describe("cleanup rules (D-055 / D-056 / D-057)", () => {
  it("pins the approved retention windows", () => {
    expect(FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY).toBe(14);
    expect(DRAFT_IDLE_DAYS).toBe(45);
    expect(DRAFT_WARNING_DAYS).toBe(38);
    expect(DRAFT_NOTICE_DAYS).toBe(7);
    expect(PENDING_UPLOAD_DAYS).toBe(7);
    expect(ORPHAN_OBJECT_DAYS).toBe(7);
    expect(OLD_EXPORT_ROW_DAYS).toBe(30);
    expect(UNLOCK_ATTEMPT_HOURS).toBe(24);
    expect(STALE_AGENT_RUN_HOURS).toBe(1);
    expect(EXPIRY_WARNING_DAYS_BEFORE).toBe(3);
    expect(CRON_TIME_BUDGET_MS).toBe(240_000);
  });

  it("constants satisfy the SQL argument checks of migration 1600", () => {
    for (const n of Object.values(CLEANUP_BATCH)) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(1000); // every p_limit is checked 1..1000
    }
    expect(CLEANUP_BATCH.orphanObjects).toBeLessThanOrEqual(STORAGE_REMOVE_MAX);
    expect(UNLOCK_ATTEMPT_HOURS).toBeGreaterThanOrEqual(24); // cleanup_unlock_attempts: p_hours < 24 → 22023
    expect(migration).toContain("p_hours < 24 or p_hours > 8760");
    expect(EXPIRY_WARNING_DAYS_BEFORE).toBeLessThanOrEqual(30);
    expect(DRAFT_WARNING_DAYS).toBeLessThan(DRAFT_IDLE_DAYS); // claim_draft_warnings: delete > warn
    expect(STALE_AGENT_RUN_HOURS).toBeGreaterThanOrEqual(1);
    expect(OLD_EXPORT_ROW_DAYS).toBeGreaterThanOrEqual(1); // > the 24 h export cap window
    expect([...CLEANUP_BUCKETS]).toEqual(["photos", "exports"]);
    expect(migration).toContain("p_bucket not in ('photos', 'exports')");
    expect([...WARNING_KINDS]).toEqual(["expiry", "draft"]);
    expect(migration).toContain("p_kind not in ('expiry', 'draft')");
  });

  it("stays client-safe (imported by legal pages / FAQ)", () => {
    expect(src).not.toMatch(/"server-only"|@\/lib\/supabase|process\.env|from "node:/);
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["@/lib/publish/rules"]);
  });

  it("freeBookDeleteAfter = expiry + 14 days", () => {
    const exp = new Date("2026-12-01T10:00:00Z");
    expect(freeBookDeleteAfter(exp).toISOString()).toBe("2026-12-15T10:00:00.000Z");
  });

  it("draftDeleteAfter mirrors the SQL notice rule", () => {
    const last = new Date("2026-01-01T00:00:00Z");
    expect(draftDeleteAfter(last, null).getTime()).toBe(last.getTime() + 45 * DAY);
    // warning before the last activity doesn't count
    expect(draftDeleteAfter(last, new Date(last.getTime() - DAY)).getTime()).toBe(last.getTime() + 45 * DAY);
    // warned on day 38 → day 45
    expect(draftDeleteAfter(last, new Date(last.getTime() + 38 * DAY)).getTime()).toBe(last.getTime() + 45 * DAY);
    // warned late (day 100, e.g. a launch backlog) → full 7 days of notice
    expect(draftDeleteAfter(last, new Date(last.getTime() + 100 * DAY)).getTime()).toBe(last.getTime() + 107 * DAY);
  });

  it("retentionSummary states the same numbers in plain English", () => {
    const rules = retentionSummary();
    expect(rules.map((r) => r.key)).toEqual(["paid", "free_published", "draft", "pending_upload", "pdf", "ai_notes"]);
    const text = (k: string) => rules.find((r) => r.key === k)!.text;
    expect(text("free_published")).toContain(`${FREE_LINK_DAYS} days after you first publish`);
    expect(text("free_published")).toContain(`${EXPIRY_WARNING_DAYS_BEFORE} days before it expires`);
    expect(text("free_published")).toContain(`${FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY} days after the link expires`);
    expect(text("draft")).toContain(`${DRAFT_IDLE_DAYS} days without changes`);
    expect(text("draft")).toContain(`${DRAFT_NOTICE_DAYS} days before`);
    expect(text("pending_upload")).toContain(`${PENDING_UPLOAD_DAYS} days`);
    for (const r of rules) expect(r.text).not.toMatch(/\b1 days\b/);
  });
});
