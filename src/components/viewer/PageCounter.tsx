// "Cover", "5 / 20", spread "4–5 / 20", "End". Text from the pure pageCounterLabel helper.

import { pageCounterLabel, type FlipLayout } from "@/lib/viewer/pages";

export function PageCounter({ layout, current, spread }: { layout: FlipLayout; current: number; spread: boolean }) {
  return (
    <span className="min-w-[4.5rem] text-center text-sm text-neutral-700 tabular-nums" aria-live="polite" data-testid="page-counter">
      {pageCounterLabel(layout, current, spread)}
    </span>
  );
}
