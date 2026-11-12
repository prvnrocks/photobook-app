// fix-ai-off-rebuild: router.refresh() under a route loading.tsx could stay pending forever (lost React
// ping inside the visible loading Suspense boundary → "Rebuilding…" never cleared). useRefreshTransition
// nudges React while the refresh is pending. Root cause in src/lib/app/refresh-nudge.ts; the live
// check is e2e/ai-auth.spec.ts test e (AI-off "Rebuild album").
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFRESH_NUDGE_MAX_MS, REFRESH_NUDGE_MS, startRefreshNudges } from "@/lib/app/refresh-nudge";

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("startRefreshNudges", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("nudges once per interval while running, first nudge one interval after start", () => {
    const nudge = vi.fn();
    const stop = startRefreshNudges(nudge);
    expect(nudge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REFRESH_NUDGE_MS - 1);
    expect(nudge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(nudge).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFRESH_NUDGE_MS * 3);
    expect(nudge).toHaveBeenCalledTimes(4);
    stop();
  });

  it("stops for good when the refresh settles (stop is idempotent)", () => {
    const nudge = vi.fn();
    const stop = startRefreshNudges(nudge);
    vi.advanceTimersByTime(REFRESH_NUDGE_MS * 2);
    stop();
    stop();
    vi.advanceTimersByTime(REFRESH_NUDGE_MS * 20);
    expect(nudge).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up after maxMs so a refresh that is really stuck (offline) doesn't re-render forever", () => {
    const nudge = vi.fn();
    startRefreshNudges(nudge, { intervalMs: 100, maxMs: 1_000 });
    vi.advanceTimersByTime(5_000);
    expect(nudge).toHaveBeenCalledTimes(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("default cap is generous compared with a refresh (~1 s) and the interval is short", () => {
    expect(REFRESH_NUDGE_MS).toBeGreaterThanOrEqual(100);
    expect(REFRESH_NUDGE_MS).toBeLessThanOrEqual(500);
    expect(REFRESH_NUDGE_MAX_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("uses injected timers (no globals needed)", () => {
    let tick: (() => void) | null = null;
    let now = 0;
    const cleared: unknown[] = [];
    const timers = {
      setInterval: (fn: () => void) => {
        tick = fn;
        return "id-1";
      },
      clearInterval: (id: unknown) => cleared.push(id),
      now: () => now,
    };
    const nudge = vi.fn();
    const stop = startRefreshNudges(nudge, { timers, maxMs: 500 });
    tick!();
    now = 400;
    tick!();
    expect(nudge).toHaveBeenCalledTimes(2);
    now = 600;
    tick!();
    expect(nudge).toHaveBeenCalledTimes(2);
    expect(cleared).toEqual(["id-1"]);
    stop();
    expect(cleared).toEqual(["id-1"]);
  });
});

describe("review refreshes go through useRefreshTransition", () => {
  const hook = read("src/components/app/use-refresh-transition.ts");

  it("the hook nudges only while pending and refreshes inside its own transition", () => {
    expect(hook.startsWith('"use client";')).toBe(true);
    expect(hook).toMatch(/if \(!pending\) return;\s*return startRefreshNudges\(nudge\);/);
    expect(hook).toContain("startTransition(() => router.refresh())");
  });

  it.each(["RebuildButton.tsx", "ReviewBody.tsx", "ReviewGrid.tsx"])(
    "%s never calls router.refresh() directly (it would hang under review/loading.tsx)",
    (file) => {
      const src = read(`src/components/review/${file}`);
      expect(src).toContain("useRefreshTransition()");
      // Comments may mention router.refresh; code must not call it.
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code).not.toMatch(/router\.refresh\(/);
      expect(code).not.toMatch(/useTransition\(/);
    },
  );

  it("the review route still has its loading skeleton (the fix keeps it, D-067)", () => {
    expect(fs.existsSync(path.join(ROOT, "src/app/books/[id]/review/loading.tsx"))).toBe(true);
  });
});
