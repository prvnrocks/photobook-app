// The ONE rule-based draft album pipeline (M13 T2, D-070; review fix 6). Pure, server or client.
// Used by finalize's fallback album (src/lib/photos/finalize.ts) and the setup card re-layout
// (updateBookSetupAction): autolayout → withBookDesign → applyBackgroundSuggestions → validate.
// Page cap = limitsFor(isPaid).maxPages in both callers (the same cap autolayout fills to).

import { autolayout, type AutoPhoto } from "@/lib/autolayout";
import { limitsFor } from "@/lib/ai/limits";
import { isSupportedDesign, withBookDesign, type BookDesign } from "@/lib/book/book-design";
import type { CaptionLang, Occasion } from "@/lib/book/options";
import { parseBookDoc, validateBookDoc } from "@/lib/book/schema";
import type { BookDoc } from "@/lib/book/types";
import { applyBackgroundSuggestions, type SuggestPhoto } from "@/lib/design/background-suggest";

/** Photo columns the rule draft needs (a subset of FinalizePhotoRow). */
export type DraftPhotoRow = {
  id: string;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  date_source: string | null;
  place: string | null;
  blur_score: number | null;
  status: string;
  dup_group: number | null;
  color: string | null;
};

export type RuleDraftInput = {
  occasion: Occasion;
  title: string | null;
  captionLang: CaptionLang;
  isPaid: boolean;
  design: BookDesign;
};

export type RuleDraftResult =
  | { ok: true; doc: BookDoc; pageCount: number }
  | { ok: false; reason: "unsupported_design" | "invalid" };

const positive = (v: number | null): number => (v !== null && Number.isFinite(v) && v > 0 ? v : 1);
const asDateSource = (v: string | null): AutoPhoto["dateSource"] => (v === "exif" || v === "file" ? v : null);
const asStatus = (v: string): "kept" | "dropped" => (v === "dropped" ? "dropped" : "kept");

/**
 * The rule-based draft album for `photos` (ready photos of the book) with the given setup:
 * autolayout, stamped with the book design, rule background suggestions, then validated against
 * the photo ids and the tier's page cap. Never throws for an unsupported style (typed refusal).
 */
export function buildRuleDraft(photos: readonly DraftPhotoRow[], input: RuleDraftInput): RuleDraftResult {
  if (!isSupportedDesign(input.design)) return { ok: false, reason: "unsupported_design" };
  const auto: AutoPhoto[] = photos.map((p) => ({
    id: p.id,
    width: positive(p.width),
    height: positive(p.height),
    takenAt: p.taken_at,
    dateSource: asDateSource(p.date_source),
    place: p.place,
    status: asStatus(p.status),
    dupGroup: p.dup_group,
    blurScore: p.blur_score,
  }));
  const suggest: SuggestPhoto[] = photos.map((p) => ({
    id: p.id,
    status: asStatus(p.status),
    color: p.color,
    width: p.width,
    height: p.height,
    blurScore: p.blur_score,
  }));
  const doc = applyBackgroundSuggestions(
    withBookDesign(
      autolayout(auto, {
        occasion: input.occasion,
        title: input.title,
        captionLang: input.captionLang,
        isPaid: input.isPaid,
        design: input.design,
      }),
      input.design,
    ),
    suggest,
  );
  const parsed = parseBookDoc(doc);
  const issues = parsed.ok
    ? validateBookDoc(parsed.doc, { photoIds: new Set(photos.map((p) => p.id)), maxPages: limitsFor(input.isPaid).maxPages })
    : parsed.issues;
  if (issues.length > 0) return { ok: false, reason: "invalid" };
  return { ok: true, doc, pageCount: doc.pages.length };
}
