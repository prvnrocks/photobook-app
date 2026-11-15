// Share page plan card (M21 T4; replaces M11's PlanCompareCard, D-067). Hook-free; every number
// arrives as data from publishCompare() (LIMITS / UPGRADE / FREE_LINK_DAYS), never hard-coded.
// - Free: "Free vs paid" — the summary, a two-column compare (Free | Paid · price, one-time;
//   a cross + text for what free lacks, never colour only) and the gold Upgrade CTA the panel passes
//   in (UpgradeButtonView, testid publish-upgrade → Stripe Checkout). Anchor #upgrade (My books
//   "Upgrade" link, the locked PDF card).
// - Paid: a calm "Paid · permanent" thank-you with what the upgrade includes.
// Which one shows is decided only by `isPaid` = server state (books.is_paid, set by the webhook).
// Testids kept: publish-free-notice, publish-compare, publish-compare-summary, publish-compare-price.

import { Check, Gem, X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import type { PublishCompare } from "@/lib/publish/compare";
import { SHARE_CARD, SHARE_CARD_HEADING, SHARE_EYEBROW } from "./share-classes";

export type PlanCardProps = {
  compare: PublishCompare;
  /** books.is_paid from the server (getPublishState). */
  isPaid: boolean;
  /** Free: the upgrade button (UpgradeButtonView with the gold class, testid publish-upgrade). */
  upgrade?: ReactNode;
};

const CARD = cx(SHARE_CARD, "flex flex-col gap-5");

export function PlanCard({ compare, isPaid, upgrade }: PlanCardProps) {
  if (isPaid) return <PaidPlan compare={compare} />;
  return (
    <section id="upgrade" className={CARD} data-testid="publish-free-notice" aria-labelledby="publish-compare-title">
      <div className="min-w-0">
        <p className={SHARE_EYEBROW}>Your plan · Free</p>
        <h2 id="publish-compare-title" className={cx(SHARE_CARD_HEADING, "mt-1.5")}>
          Free vs paid
        </h2>
        <p className="type-small mt-1 text-muted-foreground" data-testid="publish-compare-summary">
          {compare.summary}. Upgrade once for a permanent link, no watermark and PDF download.
        </p>
      </div>

      <table className="w-full table-fixed border-separate border-spacing-0 text-sm" data-testid="publish-compare">
        <caption className="sr-only">Free book compared with a paid book</caption>
        <colgroup>
          <col className="w-[27%] sm:w-[34%]" />
          <col className="w-[31%] sm:w-[33%]" />
          <col className="w-[42%] sm:w-[33%]" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="pb-2 text-start font-normal">
              <span className="sr-only">Feature</span>
            </th>
            <th scope="col" className="pe-2 pb-2 text-start align-bottom font-semibold text-foreground">
              Free
            </th>
            <th scope="col" className="rounded-t-2xl bg-[#f3f7f4] px-2.5 pt-3 sm:px-3 pb-2 text-start align-bottom font-semibold text-[#0e3b2e]">
              Paid
              <span className="block text-xs font-medium text-muted-foreground" data-testid="publish-compare-price">
                {compare.price} · {compare.priceNote}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {compare.rows.map((row, i) => {
            const last = i === compare.rows.length - 1;
            return (
              <tr key={row.key} data-row={row.key}>
                <th scope="row" className="border-t border-[#efe7d6] py-2.5 pe-2 text-start align-top font-normal text-muted-foreground">
                  {row.label}
                </th>
                <td className="border-t border-[#efe7d6] py-2.5 pe-2 align-top text-foreground">
                  <span className="flex items-start gap-1.5">
                    {row.freeIncluded ? null : <X className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    <span className="min-w-0">{row.free}</span>
                  </span>
                </td>
                <td className={cx("border-t border-[#dfe9e2] bg-[#f3f7f4] px-2.5 py-2.5 align-top font-semibold sm:px-3 text-[#0e3b2e]", last && "rounded-b-2xl")}>
                  <span className="flex items-start gap-1.5">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={3} aria-hidden="true" />
                    <span className="min-w-0">{row.paid}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {upgrade}
    </section>
  );
}

/** Paid books: a thank-you and what the upgrade includes (no CTA). */
function PaidPlan({ compare }: { compare: PublishCompare }) {
  return (
    <section className={CARD} data-testid="publish-plan-paid" aria-labelledby="publish-plan-paid-title">
      <div className="flex items-start gap-3">
        <span className="home-foil-fill flex size-11 shrink-0 items-center justify-center rounded-full text-[#1b1b1d]" aria-hidden="true">
          <Gem className="size-5" />
        </span>
        <div className="min-w-0">
          <p className={SHARE_EYEBROW}>Your plan</p>
          <h2 id="publish-plan-paid-title" className={cx(SHARE_CARD_HEADING, "mt-1")}>
            Paid · permanent
          </h2>
          <p className="type-small mt-1 text-muted-foreground">Thank you for upgrading — this book is yours to keep sharing.</p>
        </div>
      </div>
      <ul className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2" data-testid="publish-plan-paid-list">
        {compare.rows.map((row) => (
          <li key={row.key} className="flex min-w-0 items-start gap-2" data-row={row.key}>
            <Check className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={3} aria-hidden="true" />
            <span className="min-w-0">
              <span className="text-muted-foreground">{row.label}: </span>
              <span className="font-semibold text-[#0e3b2e]">{row.paid}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
