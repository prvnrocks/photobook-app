// Storybook page templates (Task 7, Balanced Storybook) — pure layout DATA for the four template
// families the older catalogue has no layouts for: chapter openings with an intro, storytelling
// pages (photos + a paragraph, or text only), and closing reflections. Hero and collage pages reuse
// the existing catalogue (src/lib/layouts/templates.ts tags them).
//
// Every design style × format gets the same ten templates, drawn once per format in page mm
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
 * The fourteen text template kinds every style × format gets, in catalogue order. Variants exist so a
 * page never has to repeat its neighbour and so both photo orientations fit without a heavy crop:
 * open-c / tell-1c take the orientation open-a,b / tell-1a,b do not. hero-small (a framed photo of
 * ~90 mm with a caption) is the low-resolution fallback: a photo too small for a full-bleed hero
 * still prints at ≥ 150 dpi there.
 */
export const STORY_TEMPLATE_KINDS = ["open-a", "open-b", "open-c", "tell-1a", "tell-1b", "tell-1c", "tell-2", "tell-2b", "tell-3", "tell-3b", "tell-0", "tell-0q", "close-0", "close-1", "hero-small"] as const;
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

const PW = 148;
const PH = 210;
const LW = 210;
const LH = 148;
const G = 2.5;

const PORTRAIT_PLANS: Record<StoryTextKind, Plan> = {
  "open-a": { name: "Chapter opening: photo above, title and intro below", photos: [[0, 0, PW, 110]], prefers: ["any"], date: [12, 117, 136, 123], chapter: [12, 124, 136, 139], main: [12, 142, 136, 200], panel: [0, 110, PW, PH] },
  "open-b": { name: "Chapter opening: title and intro above, photo below", photos: [[0, 92, PW, PH]], prefers: ["any"], date: [12, 12, 136, 18], chapter: [12, 19, 136, 34], main: [12, 37, 136, 84], panel: [0, 0, PW, 92] },
  "open-c": { name: "Chapter opening: tall photo, title and intro below", photos: [[0, 0, PW, 136]], prefers: ["portrait"], date: [12, 142, 136, 148], chapter: [12, 149, 136, 163], main: [12, 166, 136, 200], panel: [0, 136, PW, PH] },
  "tell-1a": { name: "Story: photo above, paragraph below", photos: [[0, 0, PW, 110]], prefers: ["landscape"], main: [12, 120, 136, 200] },
  "tell-1c": { name: "Story: portrait photo, paragraph below", photos: [[24, 12, 124, 146]], prefers: ["portrait"], main: [12, 154, 136, 200] },
  "tell-1b": { name: "Story: paragraph above, photo below", photos: [[0, 100, PW, PH]], prefers: ["landscape"], main: [12, 12, 136, 92] },
  "tell-2": { name: "Story: two photos and a paragraph", photos: [[0, 0, (PW - G) / 2, 88], [(PW + G) / 2, 0, PW, 88]], prefers: ["any", "any"], main: [12, 98, 136, 200] },
  "tell-3": { name: "Story: three photos and a paragraph", photos: [[0, 0, PW, 74], [0, 74 + G, (PW - G) / 2, 140], [(PW + G) / 2, 74 + G, PW, 140]], prefers: ["landscape", "any", "any"], main: [12, 150, 136, 200] },
  "tell-2b": { name: "Story: paragraph above two photos", photos: [[0, 120, (PW - G) / 2, PH], [(PW + G) / 2, 120, PW, PH]], prefers: ["any", "any"], main: [12, 12, 136, 110] },
  "tell-3b": { name: "Story: paragraph above three photos", photos: [[0, 72, PW, 140], [0, 140 + G, (PW - G) / 2, PH], [(PW + G) / 2, 140 + G, PW, PH]], prefers: ["landscape", "any", "any"], main: [12, 12, 136, 62] },
  "tell-0": { name: "Story: text page", photos: [], prefers: [], main: [16, 30, 132, 180] },
  "tell-0q": { name: "Story: pull quote and text", photos: [], prefers: [], quote: [16, 22, 132, 62], main: [16, 72, 132, 190] },
  "close-0": { name: "Closing reflection", photos: [], prefers: [], main: [18, 40, 130, 170], centred: true, panel: [0, 0, PW, PH] },
  "close-1": { name: "Closing reflection with a photo", photos: [[34, 20, 114, 80]], prefers: ["landscape"], main: [16, 92, 132, 190], centred: true },
  "hero-small": { name: "1 framed photo with caption (small)", photos: [[29, 44, 119, 134]], prefers: ["any"], main: [0, 0, 0, 0], caption: [18, 144, 130, 166] },
};

const LANDSCAPE_PLANS: Record<StoryTextKind, Plan> = {
  "open-a": { name: "Chapter opening: photo left, title and intro right", photos: [[0, 0, 118, LH]], prefers: ["any"], date: [128, 14, 200, 20], chapter: [128, 22, 200, 40], main: [128, 44, 200, 136], panel: [118, 0, LW, LH] },
  "open-b": { name: "Chapter opening: title and intro left, photo right", photos: [[92, 0, LW, LH]], prefers: ["any"], date: [10, 14, 82, 20], chapter: [10, 22, 82, 40], main: [10, 44, 82, 136], panel: [0, 0, 92, LH] },
  "open-c": { name: "Chapter opening: wide photo left, title and intro right", photos: [[0, 0, 126, LH]], prefers: ["landscape"], date: [136, 14, 200, 20], chapter: [136, 22, 200, 40], main: [136, 44, 200, 136], panel: [126, 0, LW, LH] },
  "tell-1a": { name: "Story: photo left, paragraph right", photos: [[0, 0, 112, LH]], prefers: ["portrait"], main: [122, 14, 200, 134] },
  "tell-1c": { name: "Story: wide photo above, paragraph below", photos: [[0, 0, LW, 96]], prefers: ["landscape"], main: [14, 104, 196, 138] },
  "tell-1b": { name: "Story: paragraph left, photo right", photos: [[98, 0, LW, LH]], prefers: ["portrait"], main: [10, 14, 88, 134] },
  "tell-2": { name: "Story: two photos and a paragraph", photos: [[0, 0, (LW - G) / 2, 84], [(LW + G) / 2, 0, LW, 84]], prefers: ["any", "any"], main: [14, 92, 196, 138] },
  "tell-3": { name: "Story: three photos and a paragraph", photos: [[0, 0, (LW - 2 * G) / 3, 80], [(LW - 2 * G) / 3 + G, 0, (2 * (LW - 2 * G)) / 3 + G, 80], [(2 * (LW - 2 * G)) / 3 + 2 * G, 0, LW, 80]], prefers: ["any", "any", "any"], main: [14, 90, 196, 138] },
  "tell-2b": { name: "Story: paragraph above two photos", photos: [[0, 62, (LW - G) / 2, LH], [(LW + G) / 2, 62, LW, LH]], prefers: ["any", "any"], main: [14, 10, 196, 52] },
  "tell-3b": { name: "Story: paragraph above three photos", photos: [[0, 62, (LW - 2 * G) / 3, LH], [(LW - 2 * G) / 3 + G, 62, (2 * (LW - 2 * G)) / 3 + G, LH], [(2 * (LW - 2 * G)) / 3 + 2 * G, 62, LW, LH]], prefers: ["portrait", "portrait", "portrait"], main: [14, 10, 196, 52] },
  "tell-0": { name: "Story: text page", photos: [], prefers: [], main: [30, 20, 180, 128] },
  "tell-0q": { name: "Story: pull quote and text", photos: [], prefers: [], quote: [30, 16, 180, 44], main: [30, 52, 180, 132] },
  "close-0": { name: "Closing reflection", photos: [], prefers: [], main: [36, 26, 174, 122], centred: true, panel: [0, 0, LW, LH] },
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

function buildOne(style: DesignStyle, format: BookFormat, kind: StoryTextKind): Layout {
  const portrait = format === "A5_PORTRAIT";
  const W = portrait ? PW : LW;
  const H = portrait ? PH : LH;
  const plan = (portrait ? PORTRAIT_PLANS : LANDSCAPE_PLANS)[kind];
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
  if (plan.date) texts.push(t("dateLabel", plan.date, "year", inks?.date));
  if (plan.chapter) texts.push(t("chapterTitle", plan.chapter, "chapter", inks?.chapter));
  if (plan.quote) texts.push(t("pageText", plan.quote, "chapter", inks?.quote, { n: 1 }));
  texts.push(t("pageText", plan.main, "body", inks?.body, { n: 0 }));

  const blocks: LayoutBlock[] = [];
  if (panelled) blocks.push({ box: pctRect(plan.panel!, W, H), fill: "panel", layer: "under" });
  if (d.bar && !panelled && !plan.centred) {
    const first = plan.date ?? plan.quote ?? plan.main;
    const y1 = first[1] - 2.6;
    blocks.push({ box: pctRect([first[0], y1 - d.bar.h, first[0] + d.bar.w, y1], W, H), fill: d.bar.fill, layer: "under" });
  } else if (d.bar && panelled) {
    const first = plan.date ?? plan.main;
    const y1 = first[1] - 2.6;
    blocks.push({ box: pctRect([first[0], y1 - d.bar.h, first[0] + d.bar.w, y1], W, H), fill: "accent", layer: "under" });
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

const STYLES: readonly DesignStyle[] = ["classic", "modern", "geometric", "scrapbook", "magazine", "editorial"];
const FORMATS: readonly BookFormat[] = ["A5_PORTRAIT", "A5_LANDSCAPE"];

/**
 * Every story template: style by style (catalogue order), portrait then landscape; per style ×
 * format the ten text templates, then its gap photo templates (STORY_PHOTO_GAPS, kind order).
 */
export const STORY_LAYOUTS: readonly Layout[] = STYLES.flatMap((style) =>
  FORMATS.flatMap((format) => [
    ...STORY_TEMPLATE_KINDS.map((kind) => buildOne(style, format, kind)),
    ...STORY_PHOTO_KINDS.filter((k) => STORY_PHOTO_GAPS[`${style}/${format}`].includes(k)).map((kind) => buildPhoto(style, format, kind)),
  ]),
);

const STORY_IDS = new Set(STORY_LAYOUTS.map((l) => l.id));
export const isStoryLayoutId = (id: string): boolean => STORY_IDS.has(id);
