"use client";
// Wizard step 5 upload stage (M20 T5, D-072), rendered by <UploadProgress variant="wizard">.
//   - running: the file being uploaded hovers as a shimmering card above an open emerald book; each
//     uploaded photo flies in and lands on a page (UploadThumbs, ≤ 12, stable slots) with a small
//     sparkle; older photos collapse into a "+N" pile. Beside it (≥ lg) / under it: an SVG ring with
//     "12 of 20" + percentage, the throttled aria-live headline, calm skipped/failed counts, a stalled
//     notice and Pause/Resume.
//   - settled (every file reached a final state, or `settled`): the pages fold into a closed book, a
//     short gold/emerald dot burst, then "Sorting next…"; `onSettled` fires once after the burst
//     (immediately with reduced motion) so the wizard can move on.
// Motion is CSS only (upload-motion.css): transforms/opacity, all under prefers-reduced-motion:
// no-preference; without it the same markup is a static final state. No canvas, no timers per frame.
//
// <UploadPickArt> is the before-pick drop zone art (open book, dashed "drop photos here" page,
// breathing glow, big "Choose photos" pill). It reacts to data-drag="over" on its button ancestor.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ImagePlus } from "lucide-react";
import type { QueueProgress } from "@/lib/upload/queue";
import { Button } from "@/components/ui/button";
import {
  burstDots,
  pileCount,
  SETTLE_MS,
  STALL_MS,
  stagePercent,
  stageState,
  THUMB_H,
  THUMB_W,
} from "./upload-stage-model";
import "./upload-motion.css";

export const UPLOAD_STALLED_COPY = "This is taking longer than usual. We keep retrying — check your connection and keep this tab open.";
export const UPLOAD_SORTING_NEXT_COPY = "Sorting next…";

export type UploadStageProps = {
  progress: QueueProgress;
  paused: boolean;
  onTogglePause: () => void;
  /** The visible headline, e.g. "12 of 20 uploaded" (follows every tick, like the ring). */
  headline: string;
  /** The same text throttled for the sr-only aria-live region (announced at most every 2 s). */
  statusText: string;
  /** <UploadThumbs> — positioned over the stage box. */
  thumbs?: ReactNode;
  /** Force the settled state (e.g. while the wizard finalizes); default: done ≥ total. */
  settled?: boolean;
  /** Fires once per settle, after the success burst (0 ms with reduced motion). */
  onSettled?: () => void;
};

const DOTS = burstDots();

export function UploadStage({ progress, paused, onTogglePause, headline, statusText, thumbs, settled, onSettled }: UploadStageProps) {
  const { done, total, uploaded, skipped, failed } = progress;
  const state = stageState(progress, paused, settled);
  const pct = stagePercent(progress);
  const pile = pileCount(uploaded);
  const celebrate = state === "settled" && uploaded > 0;

  // Stalled: no file settled for STALL_MS while running. The timer marks the progress it saw; any
  // change (new key) hides the notice again without a synchronous setState.
  const stallKey = `${done}/${total}/${state}`;
  const [stalledAt, setStalledAt] = useState<string | null>(null);
  useEffect(() => {
    if (state !== "running") return;
    const t = setTimeout(() => setStalledAt(stallKey), STALL_MS);
    return () => clearTimeout(t);
  }, [stallKey, state]);
  const stalled = state === "running" && stalledAt === stallKey;

  const settledRef = useRef(onSettled);
  useEffect(() => {
    settledRef.current = onSettled;
  });
  useEffect(() => {
    if (state !== "settled") return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => settledRef.current?.(), reduce ? 0 : SETTLE_MS);
    return () => clearTimeout(t);
  }, [state]);

  const incomingStyle: CSSProperties = {
    left: `${50 - THUMB_W / 2}%`,
    top: `${11 - THUMB_H / 2}%`,
    width: `${THUMB_W}%`,
    height: `${THUMB_H}%`,
  };

  const hint =
    state === "settled"
      ? uploaded > 0
        ? UPLOAD_SORTING_NEXT_COPY
        : "No new photos were added."
      : state === "paused"
        ? "Paused. Tap Resume to carry on."
        : "Placing them in your book…";

  return (
    <section
      className="up-stage flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-6 lg:grid lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-center lg:gap-8"
      data-testid="upload-running"
      data-variant="wizard"
      data-state={state}
    >
      <div className="up-stage-box relative mx-auto aspect-[5/4] w-full max-w-[34rem]" aria-hidden="true">
        <div className="up-glow absolute inset-x-[6%] top-[22%] bottom-[-4%] rounded-full" />
        <div className="up-incoming absolute" style={incomingStyle} data-testid="upload-incoming">
          <span className="up-incoming-card" />
        </div>
        <div className="up-book absolute inset-x-[2%] top-[24%] bottom-0">
          <div className="up-cover absolute inset-0" />
          <div className="up-page up-page-l absolute top-[4%] right-[50.5%] bottom-[5%] left-[2%]" />
          <div className="up-page up-page-r absolute top-[4%] right-[2%] bottom-[5%] left-[50.5%]" />
          <div className="up-spine absolute top-[3%] bottom-[4%] left-1/2 w-[2%] -translate-x-1/2" />
          <div className="up-closed absolute top-0 bottom-0 left-[26%] w-[48%]">
            <span className="up-closed-frame absolute inset-[7%]" />
            <span className="up-closed-check absolute top-1/2 left-1/2 flex aspect-square w-[34%] items-center justify-center rounded-full">
              <Check className="size-3/5" strokeWidth={3} />
            </span>
          </div>
        </div>
        {thumbs}
        {pile > 0 && state !== "settled" ? (
          <div className="up-pile absolute top-[16%]" data-testid="upload-pile">
            <span className="up-pile-card" />
            <span className="up-pile-card" />
            <span key={pile} className="up-pile-badge">+{pile}</span>
          </div>
        ) : null}
        {celebrate ? (
          <div className="up-burst absolute top-[62%] left-1/2" data-testid="upload-burst">
            {DOTS.map((d, i) => (
              <span
                key={i}
                className="up-dot"
                style={
                  {
                    width: d.size,
                    height: d.size,
                    background: d.color,
                    "--dx": `${d.dx}px`,
                    "--dy": `${d.dy}px`,
                    "--d": `${d.delay}ms`,
                  } as CSSProperties
                }
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 items-center gap-4 lg:flex-col lg:text-center">
          <ProgressRing done={done} total={total} uploaded={uploaded} pct={pct} />
          <div className="relative flex min-w-0 flex-1 flex-col gap-1 lg:items-center">
            {state === "settled" && uploaded > 0 ? (
              <p className="type-small font-semibold text-[#0f7a40]" data-testid="upload-settled">
                All photos are in
              </p>
            ) : null}
            <p className="type-h2 [font-variant-numeric:lining-nums_tabular-nums]" aria-hidden="true" data-testid="upload-progress">
              {headline}
            </p>
            <p className="sr-only" role="status" aria-live="polite" data-testid="upload-progress-live">
              {statusText}
            </p>
            <p
              className={`type-small text-muted-foreground ${state === "settled" && uploaded > 0 ? "up-next" : ""}`}
              data-testid={state === "settled" ? "upload-sorting-next" : "upload-hint"}
            >
              {hint}
            </p>
            {skipped > 0 || failed > 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="upload-counts">
                {[skipped > 0 ? `${skipped} skipped` : null, failed > 0 ? `${failed} failed` : null].filter(Boolean).join(" · ")}
              </p>
            ) : null}
          </div>
        </div>
        {stalled ? (
          <p
            className="rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm text-secondary-foreground"
            role="status"
            data-testid="upload-stalled"
          >
            {UPLOAD_STALLED_COPY}
          </p>
        ) : null}
        {state !== "settled" ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={onTogglePause}
            className="w-full text-base"
            data-testid="upload-pause"
          >
            {paused ? "Resume" : "Pause"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** Ring + "12 of 20" + percentage. The ring is the progressbar (same aria as the old bar). */
function ProgressRing({ done, total, uploaded, pct }: { done: number; total: number; uploaded: number; pct: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Upload progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${total} done`}
      className="up-ring relative size-24 shrink-0 sm:size-28 lg:size-36"
      data-testid="upload-ring"
    >
      <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden="true">
        <circle cx="60" cy="60" r="52" fill="none" stroke="#efe7d6" strokeWidth="10" />
        <circle
          className="up-ring-fill"
          cx="60"
          cy="60"
          r="52"
          fill="none"
          stroke="#0f7a40"
          strokeWidth="10"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="100"
          strokeDashoffset={100 - pct}
        />
      </svg>
      <span
        aria-hidden="true"
        className="absolute inset-0 flex flex-col items-center justify-center leading-tight [font-variant-numeric:lining-nums_tabular-nums]"
      >
        <span className="text-sm font-semibold text-primary sm:text-base lg:text-xl" data-testid="upload-ring-count">
          {uploaded} of {total}
        </span>
        <span className="text-xs text-muted-foreground lg:text-sm" data-testid="upload-percent">
          {pct}%
        </span>
      </span>
    </div>
  );
}

/**
 * Before-pick art for the wizard's pick button (T6 renders it as the button's content, with
 * UPLOAD_PICK_WIZARD_CLASS). Decorative except the "Choose photos" label + hint, which name the button.
 */
export function UploadPickArt({ hint = "Select as many as you like at once. iPhone photos (HEIC) work too." }: { hint?: string }) {
  return (
    <span className="up-pick flex w-full flex-col items-center gap-4" data-testid="upload-pick-art">
      <span aria-hidden="true" className="up-pick-book relative block aspect-[8/5] w-full max-w-[19rem] sm:max-w-[24rem]">
        <span className="up-glow absolute inset-[-4%] rounded-full" />
        <span className="up-cover absolute inset-x-[3%] inset-y-[5%]" />
        <span className="up-pick-page up-pick-page-l absolute top-[9%] right-1/2 bottom-[9%] left-[6%] p-[5%]">
          <span className="flex size-full flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-[#b38f1d] px-1 text-center">
            <ImagePlus className="size-6 text-primary sm:size-7" strokeWidth={1.75} />
            <span className="text-xs leading-tight font-medium text-primary sm:text-sm">
              <span className="[@media(pointer:fine)]:hidden">Your photos go here</span>
              <span className="hidden [@media(pointer:fine)]:inline">Drop photos here</span>
            </span>
          </span>
        </span>
        <span className="up-pick-page up-pick-page-r absolute top-[9%] right-[6%] bottom-[9%] left-1/2 flex flex-col gap-[8%] p-[8%]">
          <span className="block h-[46%] rounded-sm bg-[#e8ddc6]" />
          <span className="flex h-[30%] gap-[8%]">
            <span className="block flex-1 rounded-sm bg-[#efe6d3]" />
            <span className="block flex-1 rounded-sm bg-[#efe6d3]" />
          </span>
        </span>
        <span className="up-spine absolute top-[8%] bottom-[8%] left-1/2 w-[2%] -translate-x-1/2" />
      </span>
      <span className="up-pick-cta inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-accent-strong px-7 text-base font-semibold text-accent-strong-foreground shadow-card">
        <ImagePlus aria-hidden="true" className="size-5" />
        Choose photos
      </span>
      <span className="type-small max-w-[22rem] text-muted-foreground">{hint}</span>
    </span>
  );
}
