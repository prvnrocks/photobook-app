import { describe, expect, it } from "vitest";
import { newTickTimer, storyTimingOn, timeDeps } from "@/lib/ai/story/tick-timing";

// Task 8 follow-up: opt-in tick timing (STORY_TICK_TIMING=1) — off by default, results untouched,
// one line with stage names, counts and milliseconds only.

describe("story tick timing", () => {
  it("is off unless STORY_TICK_TIMING=1", () => {
    expect(storyTimingOn({})).toBe(false);
    expect(storyTimingOn({ STORY_TICK_TIMING: "true" })).toBe(false);
    expect(storyTimingOn({ STORY_TICK_TIMING: "1" })).toBe(true);
  });

  it("times every dependency call (sync, async, throwing) without changing results; the line has no arguments or results", async () => {
    let t = 0;
    const timer = newTickTimer();
    const deps = {
      read: async (secret: string) => {
        t += 120;
        return `row for ${secret}`;
      },
      size: () => {
        t += 5;
        return 8;
      },
      boom: async () => {
        t += 30;
        throw new Error("nope");
      },
      label: "kept as is",
    };
    const d = timeDeps(deps, timer, () => t);
    expect(await d.read("photo-123")).toBe("row for photo-123");
    expect(await d.read("photo-456")).toBe("row for photo-456");
    expect(d.size()).toBe(8);
    await expect(d.boom()).rejects.toThrow("nope");
    expect(d.label).toBe("kept as is");
    expect(timer.calls.get("read")).toEqual({ n: 2, ms: 240 });
    const line = timer.line({ ms: 400, from: "discovering", to: "organizing", end: "stage_change" });
    expect(line).toBe("[story-timing] ms=400 from=discovering to=organizing end=stage_change deps=read:2x240,boom:1x30,size:1x5");
    expect(line).not.toContain("photo-");
  });
});
