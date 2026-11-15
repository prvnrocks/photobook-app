// Free vs upgraded comparison card on the share page (M11 T15, D-067). Moved out of PublishPanel in
// M21 T3 unchanged (T4 restyles it). Hook-free; numbers arrive as data from publishCompare().

import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import type { PublishCompare } from "@/lib/publish/compare";

const CARD = "flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-5";

/** Free vs upgraded, numbers from publishCompare() (LIMITS / UPGRADE / FREE_LINK_DAYS). */
export function PlanCompareCard({ compare, children }: { compare: PublishCompare; children: ReactNode }) {
  return (
    <section id="upgrade" className={CARD} data-testid="publish-free-notice" aria-labelledby="publish-compare-title">
      <div>
        <h2 id="publish-compare-title" className="type-h2 text-foreground">
          Free or upgraded
        </h2>
        <p className="type-small mt-1 text-muted-foreground" data-testid="publish-compare-summary">
          {compare.summary}. Upgrade once for a permanent link, no watermark and PDF download.
        </p>
      </div>
      <table className="type-small w-full table-fixed border-collapse text-start" data-testid="publish-compare">
        <caption className="sr-only">Free book compared with an upgraded book</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="w-[28%] pb-2 text-start font-normal">
              <span className="sr-only">Feature</span>
            </th>
            <th scope="col" className="pb-2 text-start align-bottom font-semibold text-foreground">
              Free
            </th>
            <th scope="col" className="pb-2 text-start align-bottom font-semibold text-foreground">
              Upgraded
              <span className="block text-xs font-normal text-muted-foreground" data-testid="publish-compare-price">
                {compare.price} · {compare.priceNote}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {compare.rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-0" data-row={row.key}>
              <th scope="row" className="py-2.5 pe-2 text-start align-top font-normal text-muted-foreground">
                {row.label}
              </th>
              <td className="py-2.5 pe-2 align-top text-foreground">
                <span className="flex items-start gap-1.5">
                  {row.freeIncluded ? null : <X className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className="min-w-0">{row.free}</span>
                </span>
              </td>
              <td className="py-2.5 align-top font-medium text-foreground">
                <span className="flex items-start gap-1.5">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
                  <span className="min-w-0">{row.paid}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </section>
  );
}
