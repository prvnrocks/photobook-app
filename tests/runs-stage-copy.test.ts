import { describe, expect, it } from "vitest";
import { isIosDevice } from "@/lib/device";
import type { RunProgress } from "@/lib/runs/client";
import { limitCopy, newerSnapshot, stageCopy } from "@/lib/runs/stage-copy";

const p = (over: Partial<RunProgress> = {}): RunProgress => ({
  phase: "curating",
  photosTotal: 40,
  photosDone: 10,
  batchesTotal: 4,
  batchesDone: 1,
  photosCapped: 0,
  ...over,
});

describe("stageCopy", () => {
  it("curating shows done / total and moves the bar within 5–75 %", () => {
    expect(stageCopy("curating", p())).toEqual({
      text: "Looking at your photos… 10 / 40",
      detail: null,
      percent: 23,
    });
    expect(stageCopy("curating", p({ photosDone: 0 })).percent).toBe(5);
    expect(stageCopy("curating", p({ photosDone: 40 })).percent).toBe(75);
    expect(stageCopy("curating", p({ photosDone: 99 })).text).toBe("Looking at your photos… 40 / 40");
  });

  it("curating without totals yet has no counts", () => {
    expect(stageCopy("curating", null)).toEqual({ text: "Looking at your photos…", detail: null, percent: 5 });
    expect(stageCopy("curating", p({ photosTotal: 0, photosDone: 0 })).text).toBe("Looking at your photos…");
  });

  it("capped photos get a second line", () => {
    expect(stageCopy("curating", p({ photosCapped: 12 })).detail).toBe("…12 more checked quickly");
  });

  it.each([
    ["queued", "Getting ready…"],
    ["storytelling", "Finding your moments…"],
    ["captioning", "Final check…"],
    ["critiquing", "Final check…"],
    ["repairing", "Final check…"],
    ["validating", "Final check…"],
    ["done", "Your album is ready"],
  ] as const)("%s → %s", (state, text) => {
    expect(stageCopy(state, p()).text).toBe(text);
  });

  it("percent never decreases along the stage order", () => {
    const order = ["queued", "curating", "storytelling", "captioning", "validating", "done"] as const;
    const percents = order.map((s) => stageCopy(s, p({ photosDone: 40 })).percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
  });
});

describe("newerSnapshot", () => {
  it("later stage wins, regardless of arrival order", () => {
    const a = { state: "curating" as const, progress: p({ photosDone: 40 }) };
    const b = { state: "storytelling" as const, progress: p({ phase: "storytelling" }) };
    expect(newerSnapshot(a, b)).toBe(b);
    expect(newerSnapshot(b, a)).toBe(b);
  });

  it("within a stage, more photos done wins; ties keep current", () => {
    const a = { state: "curating" as const, progress: p({ photosDone: 10 }) };
    const b = { state: "curating" as const, progress: p({ photosDone: 20 }) };
    expect(newerSnapshot(a, b)).toBe(b);
    expect(newerSnapshot(b, a)).toBe(b);
    const c = { state: "curating" as const, progress: p({ photosDone: 10 }) };
    expect(newerSnapshot(a, c)).toBe(a);
  });

  it("the initial empty snapshot is replaced by one with totals", () => {
    const empty = { state: "queued" as const, progress: null };
    const q = { state: "queued" as const, progress: p({ phase: "queued", photosDone: 0 }) };
    expect(newerSnapshot(empty, q)).toBe(q);
  });
});

describe("limitCopy", () => {
  it("per limit", () => {
    expect(limitCopy("daily_builds", false, 3)).toBe("You've used today's 3 free AI builds — try again tomorrow.");
    expect(limitCopy("daily_builds", true, 20)).toBe("You've used today's 20 AI builds — try again tomorrow.");
    expect(limitCopy("rebuilds", false, 3)).toBe("No AI rebuilds left for this book.");
    expect(limitCopy("analysed_photos", false, 3)).toMatch(/more photos/);
    expect(limitCopy("rate", false, 3)).toMatch(/wait a few seconds/);
  });
});

describe("isIosDevice", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone", 5, true],
    ["Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)", "iPad", 5, true],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5, true], // iPadOS desktop UA
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0, false], // real Mac
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8)", "Linux armv8l", 5, false],
  ])("%s / %s / %i → %s", (ua, platform, touch, expected) => {
    expect(isIosDevice(ua, platform, touch)).toBe(expected);
  });
});
