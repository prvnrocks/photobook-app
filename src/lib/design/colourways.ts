// Accent colourways of the magazine + editorial styles (M30, D-090). Pure data, client-safe: the
// ids come from the doc schema as TYPES only (no zod at runtime); tests keep the two lists equal.
//
// A book stores `style.colourway = { id, source }` (schema.ts); absent = the style's default. The
// same id can exist in both styles (teal, coral) with different colours — always look a colourway
// up with its style. Every colour is a literal hex: no CSS color-mix (Safari < 16.2, lesson M28)
// and nothing computed at render time, so screen, PDF and the OG card agree.
//
// Roles (contrast checked in tests/m30-colourways.test.ts, WCAG 2 ratios):
//   accent        vivid colour on dark panels and over photos (≥ 3:1 on `panel`)
//   accentOnLight the same hue deepened for text / rules on white pages (≥ 4.5:1 on #FFFFFF)
//   panel         dark text-panel fill (charcoal, slightly tinted per colourway)
//   onPanel       body text on the panel (≥ 4.5:1)
// Magazine values follow ref mg-5 (lime on charcoal); editorial follows ref mg-covers.

import type { EDITORIAL_COLOURWAY_IDS, MAGAZINE_COLOURWAY_IDS } from "@/lib/book/schema";
import type { DesignStyle } from "@/lib/book/types";

export type MagazineColourwayId = (typeof MAGAZINE_COLOURWAY_IDS)[number];
export type EditorialColourwayId = (typeof EDITORIAL_COLOURWAY_IDS)[number];
export type ColourwayId = MagazineColourwayId | EditorialColourwayId;
/** Styles that have colourways. */
export type ColourwayStyle = "magazine" | "editorial";

export interface Colourway {
  id: ColourwayId;
  /** Name shown in the editor picker. */
  label: string;
  accent: string;
  accentOnLight: string;
  panel: string;
  onPanel: string;
}

// Key order = picker order; the first entry is the style's default (same order as the schema lists).
const MAGAZINE: Record<MagazineColourwayId, Colourway> = {
  lime: { id: "lime", label: "Lime", accent: "#B9D531", accentOnLight: "#566B00", panel: "#26282B", onPanel: "#FFFFFF" },
  sunset: { id: "sunset", label: "Sunset", accent: "#FF8A3D", accentOnLight: "#B4470A", panel: "#2A2523", onPanel: "#FFFFFF" },
  sky: { id: "sky", label: "Sky", accent: "#4FC3F7", accentOnLight: "#0B6FA4", panel: "#20272E", onPanel: "#FFFFFF" },
  coral: { id: "coral", label: "Coral", accent: "#FF6F61", accentOnLight: "#C2372B", panel: "#2B2424", onPanel: "#FFFFFF" },
  teal: { id: "teal", label: "Teal", accent: "#2EC4B6", accentOnLight: "#0B7A70", panel: "#1F2A2A", onPanel: "#FFFFFF" },
  gold: { id: "gold", label: "Gold", accent: "#F2C14E", accentOnLight: "#8A6500", panel: "#2A2720", onPanel: "#FFFFFF" },
};

const EDITORIAL: Record<EditorialColourwayId, Colourway> = {
  ink: { id: "ink", label: "Ink", accent: "#F2F2F0", accentOnLight: "#111111", panel: "#111111", onPanel: "#FFFFFF" },
  teal: { id: "teal", label: "Teal", accent: "#3FB8AF", accentOnLight: "#0E6F6E", panel: "#12292B", onPanel: "#FFFFFF" },
  coral: { id: "coral", label: "Coral", accent: "#F0616D", accentOnLight: "#C22F45", panel: "#2A1518", onPanel: "#FFFFFF" },
  cobalt: { id: "cobalt", label: "Cobalt", accent: "#6C9BFF", accentOnLight: "#1F4FBF", panel: "#101B38", onPanel: "#FFFFFF" },
  mustard: { id: "mustard", label: "Mustard", accent: "#E3B23C", accentOnLight: "#8A6200", panel: "#2A2412", onPanel: "#FFFFFF" },
  forest: { id: "forest", label: "Forest", accent: "#6FBF73", accentOnLight: "#2E6B3A", panel: "#14251A", onPanel: "#FFFFFF" },
};

export const COLOURWAYS: Record<ColourwayStyle, readonly Colourway[]> = {
  magazine: Object.values(MAGAZINE),
  editorial: Object.values(EDITORIAL),
};

const NONE: readonly Colourway[] = [];

function hasColourways(style: DesignStyle | null | undefined): style is ColourwayStyle {
  return style === "magazine" || style === "editorial";
}

/** The colourways of a style in picker order (default first); empty for the four older styles. */
export function colourwaysFor(style: DesignStyle | null | undefined): readonly Colourway[] {
  return hasColourways(style) ? COLOURWAYS[style] : NONE;
}

/** The style's default colourway (magazine → lime, editorial → ink); null for the older styles. */
export function defaultColourway(style: DesignStyle | null | undefined): Colourway | null {
  return colourwaysFor(style)[0] ?? null;
}

/**
 * The colourway a book of `style` draws with: the one with `id` when the style has it, else the
 * style's default (absent id, unknown id, an id of the other style). Null for the older styles.
 */
export function resolveColourway(style: DesignStyle | null | undefined, id: string | null | undefined): Colourway | null {
  const list = colourwaysFor(style);
  return list.find((c) => c.id === id) ?? list[0] ?? null;
}
