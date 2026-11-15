// @vitest-environment jsdom
// M20 T5 (D-072): the wizard upload stage's time-based behaviour in a real DOM — stalled notice,
// onSettled after the burst (immediately with reduced motion), the throttled aria-live text vs the
// per-tick headline, and object URLs (≤ 12 alive, all revoked on unmount).
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueProgress } from "@/lib/upload/queue";
import { UploadProgress } from "@/components/upload/UploadProgress";
import { UploadStage, UPLOAD_STALLED_COPY } from "@/components/upload/UploadStage";
import { UploadThumbs, useThumbStrip, type ThumbStripControl } from "@/components/upload/UploadThumbs";
import { SETTLE_MS, STAGE_MAX_THUMBS, STALL_MS } from "@/components/upload/upload-stage-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const p = (over: Partial<QueueProgress> = {}): QueueProgress => ({
  type: "progress", done: 2, total: 20, uploaded: 2, failed: 0, skipped: 0, retried: 0, ...over,
});

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("reduce"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
  setReducedMotion(false);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const renderStage = (progress: QueueProgress, extra: { paused?: boolean; onSettled?: () => void } = {}) =>
  act(() =>
    root.render(
      <UploadStage
        progress={progress}
        paused={extra.paused ?? false}
        onTogglePause={() => {}}
        headline="h"
        statusText="s"
        onSettled={extra.onSettled}
      />,
    ),
  );

describe("stalled notice", () => {
  it("appears after STALL_MS without progress, hides on the next settled file, never while paused", () => {
    renderStage(p());
    act(() => vi.advanceTimersByTime(STALL_MS - 1));
    expect(q("upload-stalled")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(q("upload-stalled")?.textContent).toBe(UPLOAD_STALLED_COPY);
    expect(q("upload-pause")).not.toBeNull(); // Pause / Resume still offered

    renderStage(p({ done: 3, uploaded: 3 }));
    expect(q("upload-stalled")).toBeNull();

    renderStage(p({ done: 3, uploaded: 3 }), { paused: true });
    act(() => vi.advanceTimersByTime(STALL_MS * 2));
    expect(q("upload-stalled")).toBeNull();
  });
});

describe("onSettled", () => {
  it("fires once, after the burst", () => {
    const onSettled = vi.fn();
    renderStage(p(), { onSettled });
    renderStage(p({ done: 20, uploaded: 20 }), { onSettled });
    expect(q("upload-running")?.getAttribute("data-state")).toBe("settled");
    act(() => vi.advanceTimersByTime(SETTLE_MS - 1));
    expect(onSettled).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onSettled).toHaveBeenCalledTimes(1);
    renderStage(p({ done: 20, uploaded: 20 }), { onSettled: () => onSettled() }); // new callback identity
    act(() => vi.advanceTimersByTime(SETTLE_MS * 2));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("fires right away with reduced motion", () => {
    setReducedMotion(true);
    const onSettled = vi.fn();
    renderStage(p({ done: 20, uploaded: 20 }), { onSettled });
    act(() => vi.advanceTimersByTime(0));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

describe("aria-live throttle", () => {
  it("headline follows every tick; the live region changes at most every 2 s", () => {
    const at = (done: number) =>
      act(() => root.render(<UploadProgress progress={p({ done, uploaded: done })} paused={false} onTogglePause={() => {}} variant="wizard" />));
    at(2);
    const live = () => q("upload-progress-live")?.textContent;
    expect(live()).toBe("2 of 20 uploaded");
    at(3);
    act(() => vi.advanceTimersByTime(0)); // first change goes through (nothing announced yet)
    expect(live()).toBe("3 of 20 uploaded");
    at(4);
    at(5);
    expect(q("upload-progress")?.textContent).toBe("5 of 20 uploaded");
    expect(q("upload-ring-count")?.textContent).toBe("5 of 20");
    act(() => vi.advanceTimersByTime(1000));
    expect(live()).toBe("3 of 20 uploaded");
    act(() => vi.advanceTimersByTime(1000));
    expect(live()).toBe("5 of 20 uploaded");
  });
});

describe("object URLs", () => {
  it("at most 12 thumbnails / live URLs; all revoked on unmount", () => {
    const live = new Set<string>();
    let n = 0;
    URL.createObjectURL = vi.fn(() => {
      const u = `blob:t${n++}`;
      live.add(u);
      return u;
    });
    URL.revokeObjectURL = vi.fn((u: string) => void live.delete(u));

    let ctl: ThumbStripControl | null = null;
    function Probe() {
      const c = useThumbStrip(true);
      useEffect(() => {
        ctl = c;
      });
      return <UploadThumbs items={c.items} />;
    }
    act(() => root.render(<Probe />));
    const files = Array.from({ length: 20 }, () => new File(["x"], "a.jpg", { type: "image/jpeg" }));
    act(() => ctl!.track(0, files));
    for (let k = 0; k < 20; k++) act(() => ctl!.onQueueEvent({ type: "photo", key: k, status: "uploaded", photoId: `p${k}` }));
    expect(host.querySelectorAll('[data-testid="upload-thumb"]')).toHaveLength(STAGE_MAX_THUMBS);
    expect(live.size).toBe(STAGE_MAX_THUMBS);
    // stable slots: the 12 shown photos occupy 12 distinct positions
    const pos = [...host.querySelectorAll("li")].map((li) => `${li.style.left}/${li.style.top}`);
    expect(new Set(pos).size).toBe(STAGE_MAX_THUMBS);
    act(() => root.render(<div />));
    expect(live.size).toBe(0);
  });
});
