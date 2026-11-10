// Free-book watermark: diagonal repeating APP_NAME over a page. No hooks / no "use client", so the
// viewer and (later) /print can both use it. Place it inside a `relative` page box.
// Class-based styling only: page-flip rewrites inline styles of the page nodes it animates, and
// sizes are in container units (cqw) of the watermark box itself so it scales with the page.

import { APP_NAME } from "@/lib/brand";

const ROWS = 9;
const PER_ROW = 4;

export function Watermark({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      data-testid="watermark"
      className={`pointer-events-none absolute inset-0 z-10 overflow-hidden select-none [container-type:size] ${className ?? ""}`}
    >
      <div className="absolute top-1/2 left-1/2 flex h-[160cqh] w-[220cqw] -translate-x-1/2 -translate-y-1/2 -rotate-[30deg] flex-col justify-around">
        {Array.from({ length: ROWS }, (_, r) => (
          <div
            key={r}
            className={`flex justify-around whitespace-nowrap ${r % 2 === 1 ? "translate-x-[12cqw]" : ""}`}
          >
            {Array.from({ length: PER_ROW }, (_, i) => (
              <span
                key={i}
                className="font-sans text-[7cqw] font-semibold tracking-wide text-white/45 [text-shadow:0_0_0.4cqw_rgba(0,0,0,0.35)]"
              >
                {APP_NAME}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
