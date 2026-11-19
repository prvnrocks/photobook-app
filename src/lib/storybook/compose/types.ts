// Storybook page composition (Task 7) — shared types and codes. Pure.

import type { BookDesign } from "@/lib/book/book-design";
import type { PageTextRole } from "@/lib/book/types";
import type { TemplateFamily } from "@/lib/layouts/templates";

/** A photo as the composer sees it (from the photos row + photo_quality). */
export type ComposePhoto = {
  id: string;
  /** Stored pixel size of the ORIGINAL (print resolution); null = unknown (no DPI check). */
  width: number | null;
  height: number | null;
  /** photo_quality.overall 0–100; null = not scored. */
  quality?: number | null;
  /** What the storybook uses it for: the chapter's hero, a collage photo, or a supporting one. */
  role?: "hero" | "collage" | "supporting" | null;
  /** Visual centre of the photo (photo_quality raw.weightX / weightY, 0..1) — crop focus. */
  focus?: { x: number; y: number } | null;
  // --- lookalike signals (./contrast.ts; all optional — a photo without them is never re-dealt) ---
  /** 64-bit dHash, hex (photos.phash). */
  phash?: string | null;
  /** EXIF capture time, ISO (photos.taken_at when date_source is not "file"). */
  takenAt?: string | null;
  /** The Curator's scene (photos.ai.scene). */
  scene?: "portrait" | "group" | "landscape" | "food" | "detail" | "document" | "screenshot" | "other" | null;
  /** Clearly visible people (photos.ai.peopleCount). */
  people?: number | null;
  /** Dominant colour #rrggbb (photos.color). */
  color?: string | null;
  /** Duplicate / similar-shot group: two photos of one group never share a page. */
  group?: string | null;
};

export const PAGE_EMPHASES = ["photo", "balanced", "text"] as const;
export type PageEmphasis = (typeof PAGE_EMPHASES)[number];

/** What a page should be: the family, plus the context the deterministic rules need. */
export type PageIntent = {
  family: TemplateFamily;
  design: BookDesign;
  lang: "en" | "ar";
  emphasis?: PageEmphasis;
  /** The page's planned narrative share (storybook page.narrativeShare): templates near it win. */
  targetShare?: number;
  /** An approved template id suggested by the AI page-intent call (validated, never trusted). */
  preferredTemplateId?: string | null;
  /** Template ids of the previous pages, oldest first (repetition penalty). */
  recent?: readonly string[];
  /** Ids that must not be chosen (the previous page's, the previous chapter opening's). */
  avoid?: readonly string[];
  /** Turn crop / DPI refusals into warnings (last resort, so a page always gets a template). */
  relax?: boolean;
  /** Share of a panel's height text must fit in (default CAPACITY_SLACK 0.92; a huge value = ignore fit — last resort, then flagged). */
  fitSlack?: number;
};

/** One text to place on the page: `key` identifies it in the result (block id / element id). */
export type ComposeText = { key: string; role: PageTextRole; text: string };
export type TemplateContent = { texts: readonly ComposeText[] };

export const SELECT_WARNINGS = ["orientation_miss", "crop_heavy", "crop_subject", "low_dpi", "dpi_below_target", "repeat_recent", "preferred_ignored"] as const;
export type SelectWarning = (typeof SELECT_WARNINGS)[number];

export const NO_FIT_REASONS = ["no_template", "photo_count", "text_unplaced", "text_overflow", "crop", "low_dpi", "repeat"] as const;
export type NoFitReason = (typeof NO_FIT_REASONS)[number];

export type SlotAssignment = { photoId: string; crop: { x: number; y: number; zoom: number } };
/** `panel` = pageText panel number, or -1 for the layout's caption area. */
export type TextAssignment = { key: string; panel: number };

export type SelectResult =
  | { ok: true; templateId: string; slots: SlotAssignment[]; texts: TextAssignment[]; score: number; warnings: SelectWarning[] }
  | { ok: false; reason: NoFitReason; detail: string; tried: number };

/** validatePageLayout codes (errors block nothing by themselves: the composer reports them). */
export const LAYOUT_ERROR_CODES = [
  "text_overflow",
  "crop_excessive",
  "dpi_too_low",
  "outside_safe_area",
  "inside_bleed",
  "missing_photo",
  "template_not_approved",
  "duplicate_element_id",
] as const;
export type LayoutErrorCode = (typeof LAYOUT_ERROR_CODES)[number];
export const LAYOUT_WARNING_CODES = ["text_tight", "text_unplaced", "panel_empty", "crop_heavy", "crop_subject", "low_dpi", "dpi_below_target", "orientation_miss"] as const;
export type LayoutWarningCode = (typeof LAYOUT_WARNING_CODES)[number];

export type LayoutIssue<C extends string> = { code: C; slot?: number; panel?: number; lang?: "en" | "ar" };
export type PageLayoutReport = { ok: boolean; errors: LayoutIssue<LayoutErrorCode>[]; warnings: LayoutIssue<LayoutWarningCode>[] };

/** Composition-level notes (report.warnings), besides the per-page layout codes. */
export const COMPOSE_NOTES = ["text_unplaced", "text_split", "paragraph_moved", "photos_moved", "repeat_forced", "opener_without_photo", "page_dropped", "relaxed", "user_page_kept", "ai_choice_replaced", "lookalikes_separated", "lookalike_set_aside"] as const;
export type ComposeNote = (typeof COMPOSE_NOTES)[number];
export type ComposeWarning = { pageId: string; code: ComposeNote | LayoutErrorCode | LayoutWarningCode | SelectWarning };

/** The AI page-intent choice for one storybook page (aliases-only request, src/lib/ai/story/compose-intent.ts). */
export type PageIntentChoice = { pageId: string; family: TemplateFamily; emphasis: PageEmphasis; templateId: string };
