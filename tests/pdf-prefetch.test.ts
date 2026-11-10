import { describe, expect, it, vi } from "vitest";
import {
  chunkPhotoSchedule,
  createLimiter,
  PREFETCH_WINDOW_CHUNKS,
  PRINT_ENCODE_CONCURRENCY_MAX,
  PRINT_ENCODE_CONCURRENCY_MIN,
  PRINT_IMAGE_IN_FLIGHT,
  PRINT_IMAGE_IN_FLIGHT_LOW_MEMORY,
  functionMemoryMb,
  printEncodeConcurrency,
  printImageInFlight,
  startPrefetch,
} from "@/lib/pdf/prefetch";
import { chunkRanges } from "@/lib/pdf/rules";

// M8 render headroom: prefetch scheduling (pure) — which photos each chunk needs, when they can be
// released, and the bounded window of chunks whose photos are produced ahead of Chromium.

function doc(cover: string | null, pages: (string | null)[][]) {
  return { cover: { photoId: cover }, pages: pages.map((ids) => ({ slots: ids.map((photoId) => ({ photoId })) })) };
}

describe("concurrency", () => {
  const BIG = 8192; // MB
  it("encodes: one per vCPU, 1..4 (big function)", () => {
    expect(printEncodeConcurrency(1, BIG)).toBe(1);
    expect(printEncodeConcurrency(2, BIG)).toBe(2);
    expect(printEncodeConcurrency(3, BIG)).toBe(3);
    expect(printEncodeConcurrency(8, BIG)).toBe(4);
    expect(printEncodeConcurrency(64, BIG)).toBe(PRINT_ENCODE_CONCURRENCY_MAX);
  });

  it("Hobby sizing (2 GB / 1 vCPU): 1 encode, never more than 2 on ≤ 2 GB; 8 originals in flight", () => {
    expect(printEncodeConcurrency(1, 2048)).toBe(1);
    expect(printEncodeConcurrency(8, 2048)).toBe(2);
    expect(printEncodeConcurrency(8, 3009)).toBe(4);
    expect(printImageInFlight(2048)).toBe(PRINT_IMAGE_IN_FLIGHT_LOW_MEMORY);
    expect(PRINT_IMAGE_IN_FLIGHT_LOW_MEMORY).toBe(8);
    expect(printImageInFlight(4096)).toBe(PRINT_IMAGE_IN_FLIGHT);
    expect(functionMemoryMb({ AWS_LAMBDA_FUNCTION_MEMORY_SIZE: "2048" })).toBe(2048);
    expect(functionMemoryMb({})).toBeGreaterThan(0);
  });

  it("bad cpu counts fall back to the floor", () => {
    expect(printEncodeConcurrency(0, BIG)).toBe(PRINT_ENCODE_CONCURRENCY_MIN);
    expect(printEncodeConcurrency(-3, BIG)).toBe(PRINT_ENCODE_CONCURRENCY_MIN);
    expect(printEncodeConcurrency(Number.NaN, BIG)).toBe(PRINT_ENCODE_CONCURRENCY_MIN);
    expect(printEncodeConcurrency(2.9, BIG)).toBe(2);
  });

  it("default reads this machine and stays in bounds; in-flight limit is I/O-sized", () => {
    const n = printEncodeConcurrency();
    expect(n).toBeGreaterThanOrEqual(PRINT_ENCODE_CONCURRENCY_MIN);
    expect(n).toBeLessThanOrEqual(PRINT_ENCODE_CONCURRENCY_MAX);
    expect(PRINT_IMAGE_IN_FLIGHT).toBeGreaterThanOrEqual(PRINT_ENCODE_CONCURRENCY_MAX);
  });
});

describe("createLimiter", () => {
  async function peakOf(limit: number, jobs: number) {
    const run = createLimiter(limit);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: jobs }, (_, i) =>
        run(async () => {
          active++;
          peak = Math.max(peak, active);
          order.push(i);
          await new Promise((r) => setTimeout(r, 2));
          active--;
          return i;
        }),
      ),
    );
    return { peak, order };
  }

  it("never exceeds the limit and starts jobs FIFO", async () => {
    const { peak, order } = await peakOf(3, 10);
    expect(peak).toBe(3);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("bad limits mean 1; results and errors pass through and free the slot", async () => {
    expect((await peakOf(0, 4)).peak).toBe(1);
    expect((await peakOf(Number.NaN, 4)).peak).toBe(1);
    const run = createLimiter(1);
    await expect(run(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(run(async () => 42)).resolves.toBe(42);
  });
});

describe("chunkPhotoSchedule", () => {
  // sheets: 0 cover(c) | 1 [a,b] | 2 [b] | 3 [c,d] | 4 [e,null]  → chunks of 2 sheets: [0,1] [2,3] [4]
  const d = doc("c", [["a", "b"], ["b"], ["c", "d"], ["e", null]]);
  const ranges = chunkRanges(5, 2);

  it("uses per chunk in sheet order, deduplicated", () => {
    const s = chunkPhotoSchedule(d, ranges);
    expect(s.uses).toEqual([["c", "a", "b"], ["b", "c", "d"], ["e"]]);
  });

  it("each photo is released after its LAST chunk only", () => {
    const s = chunkPhotoSchedule(d, ranges);
    expect(s.releaseAfter).toEqual([["a"], ["b", "c", "d"], ["e"]]);
    // every used photo is released exactly once
    expect(s.releaseAfter.flat().sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("only planned photos are scheduled", () => {
    const s = chunkPhotoSchedule(d, ranges, (id) => id !== "b" && id !== "e");
    expect(s.uses).toEqual([["c", "a"], ["c", "d"], []]);
    expect(s.releaseAfter).toEqual([["a"], ["c", "d"], []]);
  });

  it("ranges past the doc (token/doc mismatch) contribute nothing; no ranges → empty", () => {
    expect(chunkPhotoSchedule(d, [{ from: 9, to: 12 }]).uses).toEqual([[]]);
    expect(chunkPhotoSchedule(d, [])).toEqual({ uses: [], releaseAfter: [] });
  });

  it("a 100-page book: 6 chunks, all photos released once", () => {
    const pages = Array.from({ length: 100 }, (_, i) => [`p${i}`, `p${(i + 1) % 100}`]);
    const s = chunkPhotoSchedule(doc("p0", pages), chunkRanges(101));
    expect(s.uses).toHaveLength(6);
    expect(new Set(s.releaseAfter.flat()).size).toBe(100);
    expect(s.releaseAfter.flat()).toHaveLength(100);
  });
});

describe("startPrefetch", () => {
  function fakeTarget() {
    const calls: [string, string[]][] = [];
    return {
      calls,
      target: {
        prefetch: (ids: Iterable<string>) => void calls.push(["prefetch", [...ids]]),
        release: (ids: Iterable<string>) => void calls.push(["release", [...ids]]),
      },
    };
  }
  const schedule = {
    uses: [["a", "b"], ["b", "c"], ["d"], ["e"]],
    releaseAfter: [["a"], ["b", "c"], ["d"], ["e"]],
  };

  it("queues the first window now (chunk order), then one chunk per finished chunk", () => {
    const { calls, target } = fakeTarget();
    const c = startPrefetch(target, schedule, 2);
    expect(calls).toEqual([
      ["prefetch", ["a", "b"]],
      ["prefetch", ["b", "c"]],
    ]);
    c.chunkDone(0);
    expect(calls.slice(2)).toEqual([
      ["release", ["a"]],
      ["prefetch", ["d"]],
    ]);
    c.chunkDone(1);
    c.chunkDone(2);
    c.chunkDone(3);
    expect(calls.slice(4)).toEqual([
      ["release", ["b", "c"]],
      ["prefetch", ["e"]],
      ["release", ["d"]],
      ["release", ["e"]],
    ]);
  });

  it("idempotent and ignores unknown chunk indexes", () => {
    const { calls, target } = fakeTarget();
    const c = startPrefetch(target, schedule, 1);
    c.chunkDone(0);
    c.chunkDone(0);
    c.chunkDone(-1);
    c.chunkDone(4);
    c.chunkDone(1.5);
    expect(calls).toEqual([
      ["prefetch", ["a", "b"]],
      ["release", ["a"]],
      ["prefetch", ["b", "c"]],
    ]);
  });

  it("window larger than the book queues everything once; default window is PREFETCH_WINDOW_CHUNKS", () => {
    const big = fakeTarget();
    startPrefetch(big.target, schedule, 99);
    expect(big.calls.map((c) => c[1])).toEqual(schedule.uses);
    const def = fakeTarget();
    startPrefetch(def.target, schedule);
    expect(def.calls).toHaveLength(PREFETCH_WINDOW_CHUNKS);
    const bad = fakeTarget();
    startPrefetch(bad.target, schedule, Number.NaN);
    expect(bad.calls).toHaveLength(PREFETCH_WINDOW_CHUNKS);
  });

  it("chunks finishing out of order (parallel tabs) still release each photo once and queue every chunk", () => {
    const { calls, target } = fakeTarget();
    const c = startPrefetch(target, schedule, 2);
    c.chunkDone(1);
    c.chunkDone(0);
    c.chunkDone(3);
    c.chunkDone(2);
    const prefetched = calls.filter((x) => x[0] === "prefetch").map((x) => x[1]);
    const released = calls.filter((x) => x[0] === "release").flatMap((x) => x[1]);
    expect(prefetched).toEqual(schedule.uses);
    expect(released.sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("empty schedule: nothing happens", () => {
    const { calls, target } = fakeTarget();
    startPrefetch(target, { uses: [], releaseAfter: [] }).chunkDone(0);
    expect(calls).toEqual([]);
  });
});

describe("startPrefetch stop() (S2)", () => {
  it("after stop, chunkDone neither releases nor queues", () => {
    const prefetch = vi.fn();
    const release = vi.fn();
    const schedule = { uses: [["a"], ["b"], ["c"]], releaseAfter: [["a"], ["b"], ["c"]] };
    const c = startPrefetch({ prefetch, release }, schedule, 2);
    expect(prefetch).toHaveBeenCalledTimes(2);
    c.stop();
    c.stop();
    c.chunkDone(0);
    expect(prefetch).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
  });
});
