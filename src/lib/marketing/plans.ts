// Free vs Paid comparison for the landing page, derived from the single sources of truth
// (CLAUDE.md freemium rules): price from pricing.ts, limits from ai/limits.ts, link expiry from
// publish/rules.ts. Pure data — tests/landing.test.tsx pins it against those constants.

import { LIMITS } from "@/lib/ai/limits";
import { UPGRADE } from "@/lib/pricing";
import { FREE_LINK_DAYS } from "@/lib/publish/rules";

export interface PlanFeature {
  key: "pages" | "link" | "watermark" | "pdf" | "ai_photos" | "rebuilds" | "rewrites";
  text: string;
  /** false → shown as a missing feature (struck / muted). */
  included: boolean;
}

export interface Plan {
  id: "free" | "paid";
  name: string;
  price: string;
  priceNote: string;
  features: PlanFeature[];
}

export function plans(): Plan[] {
  const f = LIMITS.free;
  const p = LIMITS.paid;
  return [
    {
      id: "free",
      name: "Free book",
      price: "AED 0",
      priceNote: "Try it with any book",
      features: [
        { key: "pages", text: `Up to ${f.maxPages} pages`, included: true },
        { key: "ai_photos", text: `AI picks from up to ${f.maxAnalyzedPhotos} photos`, included: true },
        { key: "rebuilds", text: `${f.maxRebuilds} AI rebuilds, ${f.maxCaptionRewrites} caption rewrites`, included: true },
        { key: "link", text: `Share link lasts ${FREE_LINK_DAYS} days`, included: true },
        { key: "watermark", text: "Small watermark on pages", included: false },
        { key: "pdf", text: "No PDF download", included: false },
      ],
    },
    {
      id: "paid",
      name: "Paid book — keep it forever",
      price: UPGRADE.label,
      priceNote: "One-time, per book. No subscription.",
      features: [
        { key: "pages", text: `Up to ${p.maxPages} pages`, included: true },
        { key: "ai_photos", text: `AI picks from up to ${p.maxAnalyzedPhotos} photos`, included: true },
        { key: "rebuilds", text: `${p.maxRebuilds} AI rebuilds, ${p.maxCaptionRewrites} caption rewrites`, included: true },
        { key: "link", text: "Permanent share link", included: true },
        { key: "watermark", text: "No watermark", included: true },
        { key: "pdf", text: "Print-quality PDF download", included: true },
      ],
    },
  ];
}
