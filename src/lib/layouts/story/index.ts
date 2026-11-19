// Storybook page templates (Task 7, Balanced Storybook) — pure layout DATA for the four template
// families the older catalogue has no layouts for: chapter openings with an intro, storytelling
// pages (photos + a paragraph, or text only), and closing reflections. Hero and collage pages reuse
// the existing catalogue (src/lib/layouts/templates.ts tags them).
//
// Every design style × format gets the same text templates (STORY_TEMPLATE_KINDS), drawn once per format in page mm
// (y down) and dressed per style below — the style decides framing (full bleed / inset / rounded /
// polaroid), text alignment and colour roles, never the text capacity rules. Generated once at
// module load from the tables in this file: deterministic, no layout maths in components.
//
// These layouts are registered with getLayout() (render, validation, edit ops) but NOT in LAYOUTS:
// the rule-based autolayout, the album Storyteller's prompt catalogue, the layout picker and every
// existing golden keep seeing exactly the pre-Task-7 catalogue. Only the storybook page composer
// (src/lib/storybook/compose) places them.
//
// Text rules (same as the M10b/M30 catalogue tests): text panels keep ≥ 10 mm from the left/right
// trim (a page may land on either side of the fold) and ≥ 8 mm from top/bottom; a story text sits
// in a "pageText" panel whose `n` is the page text's `panel` (0 = the main text, 1 = a pull quote);
// photos touching the trim bleed (book/bleed.ts), framed / rotated / rounded ones stay ≥ 4 mm in.

import type { BookFormat, DesignStyle, Layout, LayoutBlock, LayoutDecoration, LayoutSlotDef, LayoutText, Rect, TextInk } from "@/lib/book/types";

/**
 * The text template kinds every style × format gets, in catalogue order. Variants exist so a
 * page never has to repeat its neighbour and so both photo orientations fit without a heavy crop:
 * open-c / tell-1c take the orientation open-a,b / tell-1a,b do not; on A5 portrait two photos
 * side by side cannot fill ~65 % of the page in any orientation, so tell-2 takes a portrait pair,
 * tell-2b a landscape pair and tell-2c one of each (A5 landscape: tell-2 / tell-2b take any pair).
 * hero-small (a framed photo of
 * ~90 mm with a caption) is the low-resolution fallback: a photo too small for a full-bleed hero
 * still prints at ≥ 150 dpi there.
 */
export const STORY_TEMPLATE_KINDS = ["open-a", "open-b", "open-c", "tell-1a", "tell-1b", "tell-1c", "tell-2", "tell-2b", "tell-2c", "tell-3", "tell-3b", "tell-0", "tell-0q", "close-0", "close-1", "hero-small"] as const;
/**
 * Photo template kinds (hero = 1 photo, grid = collage), generated ONLY where the existing catalogue
 * has no tagged hero / collage template of that kind for a style × format (STORY_PHOTO_GAPS) —
 * existing layouts are reused wherever they exist.
 */
export const STORY_PHOTO_KINDS = ["hero-full", "hero-cap", "grid-2", "grid-2b", "grid-3", "grid-3b", "grid-4", "grid-4b", "grid-5", "grid-5b", "grid-6", "grid-6b"] as const;
export type StoryTextKind = (typeof STORY_TEMPLATE_KINDS)[number];
export type StoryPhotoKind = (typeof STORY_PHOTO_KINDS)[number];
export type StoryTemplateKind = StoryTextKind | StoryPhotoKind;

/**
 * The missing photo templates per style × format: what templates.ts can NOT tag from the existing
 * catalogue (a single page with 1–6 photos, no chapter title panel, no chapter description panel).
 * The composer never puts the same template on two consecutive pages, so every photo count needs
 * TWO templates: hero = one without and one with a caption (hero-full / hero-cap); 2–6 photos =
 * grid-N when the catalogue has one such layout, grid-N + grid-Nb when it has none.
 * tests/story-compose/templates.test.ts recomputes this table from the catalogue and fails when
 * it drifts.
 */
export const STORY_PHOTO_GAPS: Readonly<Record<`${DesignStyle}/${BookFormat}`, readonly StoryPhotoKind[]>> = {
  "classic/A5_PORTRAIT": ["grid-3", "grid-4", "grid-5", "grid-5b", "grid-6", "grid-6b"],
  "classic/A5_LANDSCAPE": ["grid-3", "grid-4", "grid-5", "grid-5b", "grid-6", "grid-6b"],
  "modern/A5_PORTRAIT": ["hero-cap", "grid-2", "grid-3", "grid-4", "grid-5", "grid-6"],
  "modern/A5_LANDSCAPE": ["grid-4", "grid-5", "grid-6"],
  "geometric/A5_PORTRAIT": ["hero-full", "hero-cap", "grid-2", "grid-3", "grid-3b", "grid-4", "grid-4b", "grid-5", "grid-5b", "grid-6", "grid-6b"],
  "geometric/A5_LANDSCAPE": ["hero-full", "hero-cap", "grid-2", "grid-3", "grid-3b", "grid-4", "grid-4b", "grid-5", "grid-5b", "grid-6", "grid-6b"],
  "scrapbook/A5_PORTRAIT": ["hero-full", "hero-cap", "grid-2", "grid-2b", "grid-3", "grid-4", "grid-5", "grid-6", "grid-6b"],
  "scrapbook/A5_LANDSCAPE": ["hero-full", "hero-cap", "grid-2", "grid-2b", "grid-3", "grid-4", "grid-4b", "grid-5", "grid-6", "grid-6b"],
  "magazine/A5_PORTRAIT": ["hero-cap", "grid-2", "grid-2b", "grid-3", "grid-3b", "grid-4", "grid-4b", "grid-5", "grid-5b", "grid-6", "grid-6b"],
  "magazine/A5_LANDSCAPE": ["hero-full", "grid-2", "grid-3", "grid-5", "grid-6"],
  "editorial/A5_PORTRAIT": ["hero-full", "grid-2", "grid-4", "grid-4b", "grid-5", "grid-6"],
  "editorial/A5_LANDSCAPE": ["hero-full", "hero-cap", "grid-2", "grid-3", "grid-4", "grid-4b", "grid-5", "grid-6"],
};

/** Short id code of each design style in a story template id: `st-<code>-<p|l>-<kind>`. */
export const STORY_STYLE_CODE: Record<DesignStyle, string> = {
  classic: "c",
  modern: "m",
  geometric: "g",
  scrapbook: "s",
  magazine: "mg",
  editorial: "ed",
};

export function storyTemplateId(style: DesignStyle, format: BookFormat, kind: StoryTemplateKind): string {
  return `st-${STORY_STYLE_CODE[style]}-${format === "A5_PORTRAIT" ? "p" : "l"}-${kind}`;
}

type Box = readonly [number, number, number, number];

/** What a template kind holds, per format, in page mm (x0, y0, x1, y1). */
interface Plan {
  name: string;
  photos: readonly Box[];
  prefers: readonly ("portrait" | "landscape" | "any")[];
  date?: Box;
  chapter?: Box;
  /** pageText panel 0: the intro / paragraph / closing reflection. */
  main: Box;
  /** pageText panel 1: a pull quote (text-only storytelling page). */
  quote?: Box;
  /** Text block centred (closings). */
  centred?: boolean;
  /** A dark panel behind the opener / closing text (magazine). */
  panel?: Box;
  /** hero-small only: a caption area instead of story text panels. */
  caption?: Box;
}

/** A photo template: slots + an optional caption area (no story text panels). */
interface PhotoPlan {
  name: string;
  photos: readonly Box[];
  prefers: readonly ("portrait" | "landscape" | "any")[];
  caption?: Box;
}

/**
 * Type size range (mm on the page, LayoutText.size) of story paragraphs and closings: 11.5 pt down
 * to 10 pt at A5 (same mm on landscape — the renderer sizes in page mm). The fitter starts at maxMm
 * and shrinks only as far as minMm; every main panel below is sized so the longest AI block (70
 * words, EN and AR, tests/story-compose/templates.test.ts) fits at minMm with an 8 % margin, and a
 * 60-word paragraph sets at or near maxMm. The role's own range (body, 3.2 → 2.8 mm) is a caption
 * size meant for chapter descriptions.
 */
export const STORY_BODY_SIZE = { maxMm: 4.05, minMm: 3.5 } as const;

const PW = 148;
const PH = 210;
const LW = 210;
const LH = 148;
const G = 2.5;

const PORTRAIT_PLANS: Record<StoryTextKind, Plan> = {
  "open-a": { name: "Chapter opening: photo above, title and intro below", photos: [[0, 0, PW, 110]], prefers: ["any"], date: [12, 117, 136, 123], chapter: [12, 124, 136, 139], main: [12, 142, 136, 200], panel: [0, 110, PW, PH] },
  "open-b": { name: "Chapter opening: title and intro above, photo below", photos: [[0, 92, PW, PH]], prefers: ["any"], date: [12, 12, 136, 18], chapter: [12, 19, 136, 34], main: [12, 37, 136, 84], panel: [0, 0, PW, 92] },
  "open-c": { name: "Chapter opening: tall photo, title and intro below", photos: [[0, 0, PW, 136]], prefers: ["portrait"], date: [12, 142, 136, 148], chapter: [12, 149, 136, 163], main: [12, 166, 136, 200], panel: [0, 136, PW, PH] },
  "tell-1a": { name: "Story: photo above, paragraph below", photos: [[0, 0, PW, 124]], prefers: ["landscape"], main: [12, 134, 136, 200] },
  "tell-1c": { name: "Story: portrait photo, paragraph below", photos: [[24, 12, 124, 146]], prefers: ["portrait"], main: [12, 154, 136, 200] },
  "tell-1b": { name: "Story: paragraph above, photo below", photos: [[0, 86, PW, PH]], prefers: ["landscape"], main: [12, 28, 136, 76] },
  "tell-2": { name: "Story: two portrait photos and a paragraph", photos: [[0, 0, (PW - G) / 2, 130], [(PW + G) / 2, 0, PW, 130]], prefers: ["portrait", "portrait"], main: [12, 140, 136, 200] },
  "tell-3": { name: "Story: three photos and a paragraph", photos: [[0, 0, PW, 74], [0, 74 + G, (PW - G) / 2, 140], [(PW + G) / 2, 74 + G, PW, 140]], prefers: ["landscape", "any", "any"], main: [12, 150, 136, 200] },
  "tell-2b": { name: "Story: paragraph above two landscape photos", photos: [[0, 66, PW, (66 + PH - G) / 2], [0, (66 + PH + G) / 2, PW, PH]], prefers: ["landscape", "landscape"], main: [12, 12, 136, 56] },
  "tell-2c": { name: "Story: wide photo, tall photo and a paragraph", photos: [[0, 0, PW, 94], [0, 94 + G, 66, PH]], prefers: ["landscape", "portrait"], main: [76, 104, 136, 202] },
  "tell-3b": { name: "Story: paragraph above three photos", photos: [[0, 72, PW, 140], [0, 140 + G, (PW - G) / 2, PH], [(PW + G) / 2, 140 + G, PW, PH]], prefers: ["landscape", "any", "any"], main: [12, 12, 136, 62] },
  "tell-0": { name: "Story: text page", photos: [], prefers: [], main: [16, 46, 132, 190] },
  "tell-0q": { name: "Story: pull quote and text", photos: [], prefers: [], quote: [16, 22, 132, 62], main: [16, 72, 132, 190] },
  "close-0": { name: "Closing reflection", photos: [], prefers: [], main: [18, 70, 130, 186], centred: true, panel: [0, 0, PW, PH] },
  "close-1": { name: "Closing reflection with a photo", photos: [[34, 20, 114, 80]], prefers: ["landscape"], main: [16, 90, 132, 172], centred: true },
  "hero-small": { name: "1 framed photo with caption (small)", photos: [[29, 44, 119, 134]], prefers: ["any"], main: [0, 0, 0, 0], caption: [18, 144, 130, 166] },
};

const LANDSCAPE_PLANS: Record<StoryTextKind, Plan> = {
  "open-a": { name: "Chapter opening: photo left, title and intro right", photos: [[0, 0, 118, LH]], prefers: ["any"], date: [128, 14, 200, 20], chapter: [128, 22, 200, 40], main: [128, 44, 200, 136], panel: [118, 0, LW, LH] },
  "open-b": { name: "Chapter opening: title and intro left, photo right", photos: [[92, 0, LW, LH]], prefers: ["any"], date: [10, 14, 82, 20], chapter: [10, 22, 82, 40], main: [10, 44, 82, 136], panel: [0, 0, 92, LH] },
  "open-c": { name: "Chapter opening: wide photo left, title and intro right", photos: [[0, 0, 126, LH]], prefers: ["landscape"], date: [136, 14, 200, 20], chapter: [136, 22, 200, 40], main: [136, 44, 200, 136], panel: [126, 0, LW, LH] },
  "tell-1a": { name: "Story: photo left, paragraph right", photos: [[0, 0, 124, LH]], prefers: ["portrait"], main: [134, 14, 200, 134] },
  "tell-1c": { name: "Story: wide photo above, paragraph below", photos: [[0, 0, LW, 96]], prefers: ["landscape"], main: [14, 104, 196, 138] },
  "tell-1b": { name: "Story: paragraph left, photo right", photos: [[86, 0, LW, LH]], prefers: ["portrait"], main: [10, 14, 76, 134] },
  "tell-2": { name: "Story: two photos and a paragraph", photos: [[0, 0, (LW - G) / 2, 102], [(LW + G) / 2, 0, LW, 102]], prefers: ["any", "any"], main: [14, 112, 196, 140] },
  "tell-3": { name: "Story: three photos and a paragraph", photos: [[0, 0, (LW - 2 * G) / 3, 80], [(LW - 2 * G) / 3 + G, 0, (2 * (LW - 2 * G)) / 3 + G, 80], [(2 * (LW - 2 * G)) / 3 + 2 * G, 0, LW, 80]], prefers: ["any", "any", "any"], main: [14, 90, 196, 138] },
  "tell-2b": { name: "Story: paragraph above two photos", photos: [[0, 48, (LW - G) / 2, LH], [(LW + G) / 2, 48, LW, LH]], prefers: ["any", "any"], main: [14, 12, 196, 40] },
  "tell-2c": { name: "Story: tall photo, wide photo and a paragraph", photos: [[0, 0, 84, LH], [84 + G, 0, LW, 76]], prefers: ["portrait", "landscape"], main: [96, 86, 196, 140] },
  "tell-3b": { name: "Story: paragraph above three photos", photos: [[0, 48, (LW - 2 * G) / 3, LH], [(LW - 2 * G) / 3 + G, 48, (2 * (LW - 2 * G)) / 3 + G, LH], [(2 * (LW - 2 * G)) / 3 + 2 * G, 48, LW, LH]], prefers: ["portrait", "portrait", "portrait"], main: [14, 12, 196, 40] },
  "tell-0": { name: "Story: text page", photos: [], prefers: [], main: [30, 30, 180, 132] },
  "tell-0q": { name: "Story: pull quote and text", photos: [], prefers: [], quote: [30, 16, 180, 44], main: [30, 52, 180, 132] },
  "close-0": { name: "Closing reflection", photos: [], prefers: [], main: [36, 44, 174, 134], centred: true, panel: [0, 0, LW, LH] },
  "close-1": { name: "Closing reflection with a photo", photos: [[20, 30, 96, 118]], prefers: ["portrait"], main: [106, 24, 192, 124], centred: true },
  "hero-small": { name: "1 framed photo with caption (small)", photos: [[60, 16, 150, 106]], prefers: ["any"], main: [0, 0, 0, 0], caption: [36, 114, 174, 134] },
};

const PCAP: Box = [14, 183, 134, 202];
const LCAP: Box = [20, 124, 190, 140];
const half = (a: number, b: number) => [(a + b - G) / 2, (a + b + G) / 2] as const;
const pMid = half(0, PW);
const PORTRAIT_PHOTO_PLANS: Record<StoryPhotoKind, PhotoPlan> = {
  "hero-full": { name: "1 photo, full page", photos: [[0, 0, PW, PH]], prefers: ["portrait"] },
  "hero-cap": { name: "1 photo with caption", photos: [[0, 0, PW, 176]], prefers: ["portrait"], caption: PCAP },
  "grid-2": { name: "2 photos stacked with caption", photos: [[0, 0, PW, (176 - G) / 2], [0, (176 + G) / 2, PW, 176]], prefers: ["landscape", "landscape"], caption: PCAP },
  "grid-3": { name: "3 photos with caption", photos: [[0, 0, PW, 100], [0, 100 + G, pMid[0], 176], [pMid[1], 100 + G, PW, 176]], prefers: ["landscape", "any", "any"], caption: PCAP },
  "grid-4": { name: "4 photos with caption", photos: [[0, 0, pMid[0], (176 - G) / 2], [pMid[1], 0, PW, (176 - G) / 2], [0, (176 + G) / 2, pMid[0], 176], [pMid[1], (176 + G) / 2, PW, 176]], prefers: ["any", "any", "any", "any"], caption: PCAP },
  "grid-5": { name: "5 photos with caption", photos: [[0, 0, pMid[0], 86], [pMid[1], 0, PW, 86], [0, 86 + G, (PW - 2 * G) / 3, 176], [(PW - 2 * G) / 3 + G, 86 + G, (2 * (PW - 2 * G)) / 3 + G, 176], [(2 * (PW - 2 * G)) / 3 + 2 * G, 86 + G, PW, 176]], prefers: ["any", "any", "portrait", "portrait", "portrait"], caption: PCAP },
  "grid-6": { name: "6 photos with caption", photos: [0, 1, 2].flatMap((r) => { const h = (176 - 2 * G) / 3; const y0 = r * (h + G); return [[0, y0, pMid[0], y0 + h], [pMid[1], y0, PW, y0 + h]] as Box[]; }), prefers: ["landscape", "landscape", "landscape", "landscape", "landscape", "landscape"], caption: PCAP },
  "grid-2b": { name: "2 photos side by side with caption", photos: [[0, 0, pMid[0], 176], [pMid[1], 0, PW, 176]], prefers: ["portrait", "portrait"], caption: PCAP },
  "grid-3b": { name: "3 photos: one tall, two stacked", photos: [[0, 0, pMid[0], 176], [pMid[1], 0, PW, (176 - G) / 2], [pMid[1], (176 + G) / 2, PW, 176]], prefers: ["portrait", "any", "any"], caption: PCAP },
  "grid-4b": { name: "4 photos: one wide, three below", photos: [[0, 0, PW, 110], ...[0, 1, 2].map((c) => { const w = (PW - 2 * G) / 3; return [c * (w + G), 110 + G, c * (w + G) + w, 176] as Box; })], prefers: ["landscape", "any", "any", "any"], caption: PCAP },
  "grid-5b": { name: "5 photos: one wide, four below", photos: [[0, 0, PW, 96], [0, 96 + G, pMid[0], (96 + G + 176 - G) / 2], [pMid[1], 96 + G, PW, (96 + G + 176 - G) / 2], [0, (96 + G + 176 + G) / 2, pMid[0], 176], [pMid[1], (96 + G + 176 + G) / 2, PW, 176]], prefers: ["landscape", "landscape", "landscape", "landscape", "landscape"], caption: PCAP },
  "grid-6b": { name: "6 photos in three columns", photos: [0, 1].flatMap((r) => { const h = (176 - G) / 2; const y0 = r * (h + G); const w = (PW - 2 * G) / 3; return [0, 1, 2].map((c) => [c * (w + G), y0, c * (w + G) + w, y0 + h] as Box); }), prefers: ["portrait", "portrait", "portrait", "portrait", "portrait", "portrait"], caption: PCAP },
};
const lMid = half(0, LW);
const LANDSCAPE_PHOTO_PLANS: Record<StoryPhotoKind, PhotoPlan> = {
  "hero-full": { name: "1 photo, full page", photos: [[0, 0, LW, LH]], prefers: ["landscape"] },
  "hero-cap": { name: "1 photo with caption", photos: [[0, 0, LW, 120]], prefers: ["landscape"], caption: LCAP },
  "grid-2": { name: "2 photos side by side with caption", photos: [[0, 0, lMid[0], 120], [lMid[1], 0, LW, 120]], prefers: ["portrait", "portrait"], caption: LCAP },
  "grid-3": { name: "3 photos with caption", photos: [[0, 0, lMid[0], 120], [lMid[1], 0, LW, (120 - G) / 2], [lMid[1], (120 + G) / 2, LW, 120]], prefers: ["portrait", "landscape", "landscape"], caption: LCAP },
  "grid-4": { name: "4 photos with caption", photos: [[0, 0, lMid[0], (120 - G) / 2], [lMid[1], 0, LW, (120 - G) / 2], [0, (120 + G) / 2, lMid[0], 120], [lMid[1], (120 + G) / 2, LW, 120]], prefers: ["landscape", "landscape", "landscape", "landscape"], caption: LCAP },
  "grid-5": { name: "5 photos with caption", photos: [[0, 0, lMid[0], 120], [lMid[1], 0, (lMid[1] + LW - G) / 2, (120 - G) / 2], [(lMid[1] + LW + G) / 2, 0, LW, (120 - G) / 2], [lMid[1], (120 + G) / 2, (lMid[1] + LW - G) / 2, 120], [(lMid[1] + LW + G) / 2, (120 + G) / 2, LW, 120]], prefers: ["portrait", "any", "any", "any", "any"], caption: LCAP },
  "grid-6": { name: "6 photos with caption", photos: [0, 1].flatMap((r) => { const h = (120 - G) / 2; const y0 = r * (h + G); const w = (LW - 2 * G) / 3; return [0, 1, 2].map((c) => [c * (w + G), y0, c * (w + G) + w, y0 + h] as Box); }), prefers: ["any", "any", "any", "any", "any", "any"], caption: LCAP },
  "grid-2b": { name: "2 photos: one large, one small", photos: [[0, 0, 130, 120], [130 + G, 0, LW, 120]], prefers: ["landscape", "portrait"], caption: LCAP },
  "grid-3b": { name: "3 photos in a row", photos: [0, 1, 2].map((c) => { const w = (LW - 2 * G) / 3; return [c * (w + G), 0, c * (w + G) + w, 120] as Box; }), prefers: ["portrait", "portrait", "portrait"], caption: LCAP },
  "grid-4b": { name: "4 photos: two tall, two wide", photos: [[0, 0, (lMid[0] - G) / 2, 120], [(lMid[0] + G) / 2, 0, lMid[0], 120], [lMid[1], 0, LW, (120 - G) / 2], [lMid[1], (120 + G) / 2, LW, 120]], prefers: ["portrait", "portrait", "landscape", "landscape"], caption: LCAP },
  "grid-5b": { name: "5 photos: three above, two below", photos: [...[0, 1, 2].map((c) => { const w = (LW - 2 * G) / 3; return [c * (w + G), 0, c * (w + G) + w, (120 - G) / 2] as Box; }), [0, (120 + G) / 2, lMid[0], 120], [lMid[1], (120 + G) / 2, LW, 120]], prefers: ["any", "any", "any", "landscape", "landscape"], caption: LCAP },
  "grid-6b": { name: "6 photos: four above, two below", photos: [...[0, 1, 2, 3].map((c) => { const w = (LW - 3 * G) / 4; return [c * (w + G), 0, c * (w + G) + w, (120 - G) / 2] as Box; }), [0, (120 + G) / 2, lMid[0], 120], [lMid[1], (120 + G) / 2, LW, 120]], prefers: ["any", "any", "any", "any", "landscape", "landscape"], caption: LCAP },
};

/** How a design style dresses the shared plans. */
interface Dress {
  /** Inset (mm) of photo edges that touch the trim; 0 = full bleed. */
  inset: number;
  shape?: LayoutSlotDef["shape"];
  /** Polaroid / border frames on templates with ≤ 2 photos (scrapbook). */
  frame?: (photos: number) => LayoutSlotDef["frame"] | undefined;
  /** Alternating tilt (degrees) of framed photos. */
  tilt?: number;
  shadow?: LayoutSlotDef["shadow"];
  /** Tape over the top edge of a single framed photo. */
  tape?: boolean;
  align: LayoutText["align"];
  /** Colour roles; absent = the page ink classes (classic / modern have no palette). */
  ink?: { date: TextInk; chapter: TextInk; body: TextInk; quote: TextInk };
  /** Dark panel behind opener + closing text, with these inks on it (magazine). */
  panel?: { date: TextInk; chapter: TextInk; body: TextInk };
  /** A short accent bar above the first text box. */
  bar?: { fill: LayoutBlock["fill"]; w: number; h: number };
}

const DRESS: Record<DesignStyle, Dress> = {
  classic: { inset: 12, align: "center" },
  modern: { inset: 0, align: "start" },
  geometric: {
    inset: 10,
    shape: { kind: "rounded", r: 5 },
    align: "start",
    ink: { date: "accent", chapter: "ink", body: "ink", quote: "accent" },
    bar: { fill: "accent", w: 18, h: 1.2 },
  },
  scrapbook: {
    inset: 14,
    frame: (n) => (n === 1 ? { kind: "polaroid", side: 3, bottom: 10 } : n === 2 ? { kind: "border", mm: 2.5, hex: "#FBF8F1" } : undefined),
    tilt: 2,
    shadow: "lifted",
    tape: true,
    align: "start",
    ink: { date: "accent", chapter: "ink", body: "ink", quote: "accent" },
  },
  magazine: {
    inset: 0,
    align: "start",
    ink: { date: "accent", chapter: "ink", body: "ink", quote: "ink" },
    panel: { date: "accentOnDark", chapter: "paper", body: "paper" },
    bar: { fill: "accentOnLight", w: 22, h: 1.6 },
  },
  editorial: {
    inset: 10,
    align: "start",
    ink: { date: "accent", chapter: "ink", body: "ink", quote: "accent" },
    bar: { fill: "accentOnLight", w: 24, h: 0.6 },
  },
};

const r4 = (n: number) => Math.round(n * 10000) / 10000;

function pctRect(b: Box, W: number, H: number): Rect {
  const x = r4((b[0] / W) * 100);
  const y = r4((b[1] / H) * 100);
  return { x, y, w: r4((b[2] / W) * 100 - x), h: r4((b[3] / H) * 100 - y) };
}

/** Move the photo edges that touch the trim inward by `m` mm. */
function inset(b: Box, m: number, W: number, H: number): Box {
  if (m === 0) return b;
  const e = 1e-6;
  return [b[0] <= e ? m : b[0], b[1] <= e ? m : b[1], b[2] >= W - e ? W - m : b[2], b[3] >= H - e ? H - m : b[3]];
}

/** Slots of `boxes` dressed for `style`. */
function dressSlots(d: Dress, boxes: readonly Box[], W: number, H: number): LayoutSlotDef[] {
  const frame = d.frame?.(boxes.length);
  return boxes.map((b, i) => {
    const slot: LayoutSlotDef = { ...pctRect(inset(b, d.inset, W, H), W, H) };
    if (d.shape) slot.shape = d.shape;
    if (frame) {
      slot.frame = frame;
      if (d.tilt) slot.rotate = i % 2 === 0 ? -d.tilt : d.tilt;
      if (d.shadow) slot.shadow = d.shadow;
    }
    return slot;
  });
}

function tapeOver(d: Dress, boxes: readonly Box[], W: number, H: number): LayoutDecoration[] {
  if (!d.tape || boxes.length !== 1 || !d.frame?.(1)) return [];
  const b = inset(boxes[0]!, d.inset, W, H);
  const cx = (b[0] + b[2]) / 2;
  return [{ kind: "tape", id: "tape-washi", box: pctRect([cx - 15, b[1] - 4, cx + 15, b[1] + 4], W, H), rotate: -4, layer: "over" }];
}

function buildPhoto(style: DesignStyle, format: BookFormat, kind: StoryPhotoKind): Layout {
  const plan = (format === "A5_PORTRAIT" ? PORTRAIT_PHOTO_PLANS : LANDSCAPE_PHOTO_PLANS)[kind];
  return { ...buildPhotoFrom(style, format, plan), id: storyTemplateId(style, format, kind) };
}

function buildPhotoFrom(style: DesignStyle, format: BookFormat, plan: PhotoPlan): Layout {
  const portrait = format === "A5_PORTRAIT";
  const W = portrait ? PW : LW;
  const H = portrait ? PH : LH;
  const d = DRESS[style];
  const caption = plan.caption ? pctRect(plan.caption, W, H) : null;
  // Design styles type the caption through a pageCaption panel on the same box (catalogue rule).
  const texts: LayoutText[] =
    caption && style !== "classic" ? [{ bind: "pageCaption", box: caption, align: d.align === "start" ? "start" : "center", font: "caption", ...(d.ink ? { ink: "muted" as const } : {}) }] : [];
  const decorations = tapeOver(d, plan.photos, W, H);
  return {
    id: "",
    name: plan.name,
    role: "page",
    style,
    format,
    photoCount: plan.photos.length,
    prefers: [...plan.prefers],
    slots: dressSlots(d, plan.photos, W, H),
    caption,
    ...(texts.length ? { texts } : {}),
    ...(decorations.length ? { decorations } : {}),
  };
}

/**
 * The page region a story paragraph owns (LayoutText.area, the narrative side of the 65 / 35
 * balance): its box grown sideways to the nearest photo or the trim, then up / down the same way —
 * the text, its accent bar and the white space around them. Plan geometry (before style insets), so
 * every style measures the same design.
 */
function textRegion(b: Box, photos: readonly Box[], W: number, H: number): Box {
  const e = 1e-6;
  const overlaps = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > e;
  let x0 = 0;
  let x1 = W;
  for (const p of photos) {
    if (!overlaps(b[1], b[3], p[1], p[3])) continue;
    if (p[2] <= b[0] + e) x0 = Math.max(x0, p[2]);
    if (p[0] >= b[2] - e) x1 = Math.min(x1, p[0]);
  }
  let y0 = 0;
  let y1 = H;
  for (const p of photos) {
    if (!overlaps(x0, x1, p[0], p[2])) continue;
    if (p[3] <= b[1] + e) y0 = Math.max(y0, p[3]);
    if (p[1] >= b[3] - e) y1 = Math.min(y1, p[1]);
  }
  return [x0, y0, x1, y1];
}

function buildOne(style: DesignStyle, format: BookFormat, kind: StoryTextKind, planOverride?: Plan): Layout {
  const portrait = format === "A5_PORTRAIT";
  const W = portrait ? PW : LW;
  const H = portrait ? PH : LH;
  const plan = planOverride ?? (portrait ? PORTRAIT_PLANS : LANDSCAPE_PLANS)[kind];
  if (plan.caption) return { ...buildPhotoFrom(style, format, plan), id: storyTemplateId(style, format, kind) };
  const d = DRESS[style];
  const n = plan.photos.length;
  const slots = dressSlots(d, plan.photos, W, H);

  // A dark text panel: magazine openers (open-a / open-b) and the text-only closing.
  const panelled = !!d.panel && !!plan.panel && (kind.startsWith("open") || kind === "close-0");
  const inks = panelled ? { ...d.panel!, quote: d.panel!.body } : d.ink;
  const align = plan.centred ? "center" : d.align;

  const texts: LayoutText[] = [];
  const t = (bind: LayoutText["bind"], box: Box, font: LayoutText["font"], ink: TextInk | undefined, extra: Partial<LayoutText> = {}): LayoutText => ({
    bind,
    box: pctRect(box, W, H),
    align,
    font,
    ...(ink ? { ink } : {}),
    ...extra,
  });
  // Storytelling pages read as body copy: the paragraph takes STORY_BODY_SIZE and sits at the top of
  // its box, right under the accent bar (a centred block floated in the middle of a tall box).
  // Closings keep the body size range too but stay centred; openers keep the role's (unchanged).
  // The text-only closing (close-0) also starts under its bar, a third of the way down the page.
  const story = kind.startsWith("tell");
  const top: Partial<LayoutText> = story || kind === "close-0" ? { valign: "start" } : {};
  if (plan.date) texts.push(t("dateLabel", plan.date, "year", inks?.date));
  if (plan.chapter) texts.push(t("chapterTitle", plan.chapter, "chapter", inks?.chapter));
  if (plan.quote) texts.push(t("pageText", plan.quote, "chapter", inks?.quote, { n: 1, ...top }));
  const area = story && n > 0 ? { area: pctRect(textRegion(plan.main, plan.photos, W, H), W, H) } : {};
  texts.push(t("pageText", plan.main, "body", inks?.body, { n: 0, ...(story || kind.startsWith("close") ? { size: { ...STORY_BODY_SIZE } } : {}), ...top, ...area }));

  const blocks: LayoutBlock[] = [];
  if (panelled) blocks.push({ box: pctRect(plan.panel!, W, H), fill: "panel", layer: "under" });
  if (d.bar && !panelled && !plan.centred) {
    const first = plan.date ?? plan.quote ?? plan.main;
    const y1 = first[1] - 2.6;
    blocks.push({ box: pctRect([first[0], y1 - d.bar.h, first[0] + d.bar.w, y1], W, H), fill: d.bar.fill, layer: "under" });
  } else if (d.bar && panelled) {
    const first = plan.date ?? plan.main;
    const y1 = first[1] - 2.6;
    // Centred text (the closing) gets a centred bar.
    const x0 = align === "center" ? (first[0] + first[2] - d.bar.w) / 2 : first[0];
    blocks.push({ box: pctRect([x0, y1 - d.bar.h, x0 + d.bar.w, y1], W, H), fill: "accent", layer: "under" });
  }

  const decorations = tapeOver(d, plan.photos, W, H);

  return {
    id: storyTemplateId(style, format, kind),
    name: plan.name,
    role: "page",
    style,
    format,
    photoCount: n,
    prefers: [...plan.prefers],
    slots,
    caption: null,
    texts,
    ...(blocks.length ? { blocks } : {}),
    ...(decorations.length ? { decorations } : {}),
  };
}

// --- fitted variants of the storytelling templates -------------------------------------------------
//
// A tell-* box is sized for the LONGEST paragraph the AI writes (70 words at 10 pt), so a typical
// 30–45 word paragraph left its lower third blank. Every tell-* kind whose paragraph sits directly
// above or below its photos also gets FITTED VARIANTS: the same template with a shorter paragraph
// box, the photos taking the height it gives up (gaps stay G, trim edges stay on the trim, the
// accent bar follows the box top). The composer's fitter (compose/select.ts) picks the shortest
// variant whose text still sets at the full body size with the 8 % margin, so the paragraph fills
// its box; longer text (also a user edit) moves back to a taller variant, and the base template
// (the longest AI text at 10 pt) is always the fallback — text never overflows because of a variant.
//
// Variants are registered layouts (render, print, validation) but NOT separate templates: the
// registry (templates.ts) lists the base only, so the AI page-intent catalogue, the approved ids
// and the "never the previous page's template" rule see one template per kind.
// Side-by-side kinds (A5 landscape tell-1a / tell-1b: a paragraph column beside a full-height
// photo) have no variants — no photo can take the height of a column.

/** Paragraph box height of each variant as a share of the base box: v1 (tallest) … v6 (shortest); 10 % steps keep the leftover below a line or two. */
export const STORY_VARIANT_STEPS = [0.9, 0.8, 0.7, 0.6, 0.5, 0.42] as const;
/** A variant's paragraph box never gets shorter than this (≈ 2 lines at 11.5 pt + margin). */
const VARIANT_MIN_BOX_MM = 14;
/**
 * The 65 / 35 balance at page level: a paragraph keeps at least this share of the page (its box +
 * its own white space, LayoutText.area) — the same floor as the base tell-* templates. Variants
 * below it are not generated, so a short paragraph never shrinks to a sliver beside huge photos.
 */
export const STORY_MIN_TEXT_SHARE = 0.2;

const variantId = (base: string, k: number) => `${base}-v${k + 1}`;

/**
 * The plan of variant `share` of a tell-* plan, or null when the kind has none (no photo directly
 * above / below the paragraph) or the box would get too short. Pure geometry in page mm.
 */
function variantPlan(plan: Plan, share: number, H: number): Plan | null {
  if (plan.photos.length === 0 || plan.caption || plan.quote) return null;
  const e = 1e-6;
  const m = plan.main;
  const boxH = m[3] - m[1];
  const d = boxH * (1 - share);
  if (boxH - d < VARIANT_MIN_BOX_MM - e) return null;
  const xOver = (p: Box) => Math.min(p[2], m[2]) - Math.max(p[0], m[0]) > e;
  const above = plan.photos.filter((p) => p[3] <= m[1] + e && xOver(p));
  const below = plan.photos.filter((p) => p[1] >= m[3] - e && xOver(p));
  if (above.length > 0 === below.length > 0) return null;
  // Stretch the photo band on the paragraph's side by d, anchored at the band's far edge; a photo
  // edge that sat one gap G past a stretched edge follows it (keeps gaps exact).
  const down = above.length > 0;
  const near = down ? Math.max(...above.map((p) => p[3])) : Math.min(...below.map((p) => p[1]));
  const far = down ? Math.min(...plan.photos.filter((p) => p[3] <= near + e).map((p) => p[1])) : Math.max(...plan.photos.filter((p) => p[1] >= near - e).map((p) => p[3]));
  const k = (Math.abs(near - far) + d) / Math.abs(near - far);
  const inBand = (y: number) => (down ? y >= far - e && y <= near + e : y <= far + e && y >= near - e);
  const map = (y: number) => (inBand(y) ? (down ? far + (y - far) * k : far - (far - y) * k) : y);
  const edges = plan.photos.flatMap((p) => [p[1], p[3]]);
  const photos = plan.photos.map((p): Box => {
    let y0 = map(p[1]);
    let y1 = map(p[3]);
    // y0 one gap below a stretched bottom edge (down) / y1 one gap above a stretched top edge (up)
    const prevEdge = down ? edges.find((y) => Math.abs(p[1] - (y + G)) < 1e-3 && inBand(y)) : undefined;
    if (prevEdge !== undefined) y0 = map(prevEdge) + G;
    const nextEdge = down ? undefined : edges.find((y) => Math.abs(p[3] - (y - G)) < 1e-3 && inBand(y));
    if (nextEdge !== undefined) y1 = map(nextEdge) - G;
    return [p[0], y0, p[2], Math.min(H, y1)];
  });
  const main: Box = down ? [m[0], m[1] + d, m[2], m[3]] : [m[0], m[1], m[2], m[3] - d];
  return { ...plan, photos, main };
}

/** Variant ids of a base template id, tallest box first (empty when it has none). */
const VARIANTS_OF = new Map<string, string[]>();
/** Variant id → its base template id. */
const BASE_OF = new Map<string, string>();

function buildVariants(style: DesignStyle, format: BookFormat, kind: StoryTextKind): Layout[] {
  if (!kind.startsWith("tell")) return [];
  const portrait = format === "A5_PORTRAIT";
  const plan = (portrait ? PORTRAIT_PLANS : LANDSCAPE_PLANS)[kind];
  const base = storyTemplateId(style, format, kind);
  const out: Layout[] = [];
  STORY_VARIANT_STEPS.forEach((share, k) => {
    const v = variantPlan(plan, share, portrait ? PH : LH);
    if (!v) return;
    const id = variantId(base, k);
    const layout = { ...buildOne(style, format, kind, v), id };
    const region = layout.texts?.find((t) => t.bind === "pageText" && (t.n ?? 0) === 0)?.area;
    if (!region || (region.w * region.h) / 10000 < STORY_MIN_TEXT_SHARE - 1e-9) return;
    out.push(layout);
    BASE_OF.set(id, base);
  });
  if (out.length) VARIANTS_OF.set(base, out.map((l) => l.id));
  return out;
}

/** The base template id of a fitted variant; any other id is its own base. */
export function storyBaseId(id: string): string {
  return BASE_OF.get(id) ?? id;
}

/** The fitted variants of a base template, tallest paragraph box first (shortest last). */
export function storyVariantsOf(baseId: string): readonly string[] {
  return VARIANTS_OF.get(baseId) ?? [];
}

export const isStoryVariantId = (id: string): boolean => BASE_OF.has(id);

const STYLES: readonly DesignStyle[] = ["classic", "modern", "geometric", "scrapbook", "magazine", "editorial"];
const FORMATS: readonly BookFormat[] = ["A5_PORTRAIT", "A5_LANDSCAPE"];

/**
 * Every story template: style by style (catalogue order), portrait then landscape; per style ×
 * format the text templates, then its gap photo templates (STORY_PHOTO_GAPS, kind order), then the
 * fitted variants of its tell-* templates (kind order, tallest box first).
 */
export const STORY_LAYOUTS: readonly Layout[] = STYLES.flatMap((style) =>
  FORMATS.flatMap((format) => [
    ...STORY_TEMPLATE_KINDS.map((kind) => buildOne(style, format, kind)),
    ...STORY_PHOTO_KINDS.filter((k) => STORY_PHOTO_GAPS[`${style}/${format}`].includes(k)).map((kind) => buildPhoto(style, format, kind)),
    ...STORY_TEMPLATE_KINDS.flatMap((kind) => buildVariants(style, format, kind)),
  ]),
);

const STORY_IDS = new Set(STORY_LAYOUTS.map((l) => l.id));
export const isStoryLayoutId = (id: string): boolean => STORY_IDS.has(id);
