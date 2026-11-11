// Free vs Paid comparison card on the publish screen (M11 T15, D-067). Server-side builder: every
// number comes from the single sources of truth (LIMITS in ai/limits.ts, UPGRADE in pricing.ts,
// FREE_LINK_DAYS in publish/rules.ts), never hard-coded. rules.ts pulls the book schema in, so this
// module is built on the server (publish page / dev fixture page) and passed to the client panel as
// plain data (PublishCompare).

import { LIMITS } from "@/lib/ai/limits";
import { UPGRADE } from "@/lib/pricing";
import { FREE_LINK_DAYS } from "@/lib/publish/rules";

export type PublishCompareRow = {
  key: "pages" | "link" | "watermark" | "pdf";
  label: string;
  free: string;
  paid: string;
  /** false → the free column is a missing feature (shown with a cross, not colour only). */
  freeIncluded: boolean;
};

export type PublishCompare = {
  /** "Free link works for N days after you publish" — the card's summary line. */
  summary: string;
  /** UPGRADE.label */
  price: string;
  priceNote: string;
  rows: PublishCompareRow[];
};

export function publishCompare(): PublishCompare {
  return {
    summary: `Free link works for ${FREE_LINK_DAYS} days after you publish`,
    price: UPGRADE.label,
    priceNote: "one-time",
    rows: [
      { key: "pages", label: "Pages", free: `Up to ${LIMITS.free.maxPages}`, paid: `Up to ${LIMITS.paid.maxPages}`, freeIncluded: true },
      { key: "link", label: "Share link", free: `${FREE_LINK_DAYS} days`, paid: "Permanent", freeIncluded: true },
      { key: "watermark", label: "Watermark", free: "Small watermark", paid: "None", freeIncluded: false },
      { key: "pdf", label: "PDF download", free: "Not included", paid: "Included", freeIncluded: false },
    ],
  };
}
