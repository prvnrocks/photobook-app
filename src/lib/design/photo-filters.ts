// Photo filters (D-089): named looks a photo can wear — richer colour, warm gold, soft matte,
// black & white, sepia… Pure data + maths, no DOM, no sharp: safe in client and server code.
//
// A filter is an ordered list of the standard CSS filter functions (brightness, contrast,
// saturate, sepia, grayscale, hue-rotate). Two outputs from the same list, so screen and PDF agree:
//   - filterCss(id)    → the CSS `filter` value for the editor / viewer (never used in print: a CSS
//                        filter makes Chromium rasterise the photo in the PDF).
//   - filterAffine(id) → (./photo-filter-matrix.ts, server + tests only, kept out of the client
//                        bundles) the same functions composed into one 3×3 matrix + offset (each
//                        function is an affine colour transform in sRGB, per the W3C Filter Effects
//                        spec); the PDF export bakes it into the print copy (lib/pdf/images.ts).
// The only difference: CSS clamps to 0..1 after every function, the composed transform once at the
// end. Recipes therefore put darkening steps before brightening / contrast ones, so nothing is
// clipped and then pulled back (tests compare both outputs on a colour grid, < 2 % apart).
//
// A filter belongs to the PHOTO (doc.filters: photoId → filter id), not to a slot: it follows the
// photo through swaps, layout changes and relayouts, and applies wherever the photo shows.

export type FilterFn = "brightness" | "contrast" | "saturate" | "sepia" | "grayscale" | "hueRotate";
/** [function, amount] — amount is a factor (1 = unchanged), 0..1 for sepia / grayscale, degrees for hueRotate. */
export type FilterOp = readonly [FilterFn, number];

export interface PhotoFilter {
  id: PhotoFilterId;
  /** Short name on the picker tile (≤ ~12 chars). */
  label: string;
  /** One line for screen readers / tooltips. */
  hint: string;
  ops: readonly FilterOp[];
}

export const PHOTO_FILTER_IDS = [
  "vivid",
  "glow",
  "golden",
  "champagne",
  "soft",
  "matte",
  "film",
  "velvet",
  "dusk",
  "rose",
  "slate",
  "mono",
  "noir",
  "silver",
  "sepia",
] as const;
export type PhotoFilterId = (typeof PHOTO_FILTER_IDS)[number];

/**
 * Catalogue order = picker order: colour looks first, then muted ones, then black & white, sepia.
 * No strong hue-rotate anywhere: rotating hues recolours everything in the photo (skin goes green
 * or blue). Rosé uses a few degrees only; warmth comes from a little sepia.
 */
export const PHOTO_FILTERS: readonly PhotoFilter[] = [
  { id: "vivid", label: "Vivid", hint: "Richer colour and a little more contrast", ops: [["saturate", 1.35], ["contrast", 1.1], ["brightness", 1.03]] },
  { id: "glow", label: "Glow", hint: "Bright, fresh and colourful", ops: [["saturate", 1.18], ["brightness", 1.1], ["contrast", 1.03]] },
  { id: "golden", label: "Golden hour", hint: "Warm gold light", ops: [["sepia", 0.22], ["saturate", 1.35], ["brightness", 1.05], ["contrast", 1.05]] },
  { id: "champagne", label: "Champagne", hint: "Bright, creamy and warm", ops: [["sepia", 0.15], ["saturate", 1.05], ["contrast", 0.96], ["brightness", 1.08]] },
  { id: "soft", label: "Soft", hint: "Gentle contrast, airy light", ops: [["saturate", 0.92], ["contrast", 0.9], ["brightness", 1.08]] },
  { id: "matte", label: "Matte", hint: "Faded, low-contrast magazine look", ops: [["saturate", 0.8], ["contrast", 0.85], ["brightness", 1.1]] },
  { id: "film", label: "Film", hint: "Warm vintage film", ops: [["brightness", 0.97], ["sepia", 0.3], ["saturate", 0.9], ["contrast", 1.12]] },
  { id: "velvet", label: "Velvet", hint: "Deep, rich and moody", ops: [["brightness", 0.93], ["saturate", 1.15], ["contrast", 1.2]] },
  { id: "dusk", label: "Dusk", hint: "Deep warm evening tones", ops: [["brightness", 0.92], ["sepia", 0.32], ["saturate", 1.2], ["contrast", 1.08]] },
  { id: "rose", label: "Rosé", hint: "A soft pink blush", ops: [["sepia", 0.18], ["hueRotate", -12], ["saturate", 1.15], ["brightness", 1.04]] },
  { id: "slate", label: "Slate", hint: "Muted, editorial colour", ops: [["grayscale", 0.5], ["brightness", 1.02], ["contrast", 1.08]] },
  { id: "mono", label: "Black & white", hint: "Classic black and white", ops: [["grayscale", 1], ["contrast", 1.05]] },
  { id: "noir", label: "Noir", hint: "High-contrast black and white", ops: [["grayscale", 1], ["brightness", 0.95], ["contrast", 1.25]] },
  { id: "silver", label: "Silver", hint: "Soft, bright black and white", ops: [["grayscale", 1], ["contrast", 0.92], ["brightness", 1.08]] },
  { id: "sepia", label: "Sepia", hint: "Antique brown tone", ops: [["sepia", 0.8], ["contrast", 1.05]] },
];

const BY_ID: ReadonlyMap<string, PhotoFilter> = new Map(PHOTO_FILTERS.map((f) => [f.id, f]));

export function isPhotoFilterId(v: unknown): v is PhotoFilterId {
  return typeof v === "string" && BY_ID.has(v);
}

export function photoFilterById(id: string | null | undefined): PhotoFilter | undefined {
  return id ? BY_ID.get(id) : undefined;
}

const fmt = (n: number) => String(Number(n.toFixed(4)));

function opCss([fn, v]: FilterOp): string {
  return fn === "hueRotate" ? `hue-rotate(${fmt(v)}deg)` : `${fn}(${fmt(v)})`;
}

/** CSS `filter` value for a filter id; undefined for none / unknown (render the photo as it is). */
export function filterCss(id: string | null | undefined): string | undefined {
  const f = photoFilterById(id);
  return f ? f.ops.map(opCss).join(" ") : undefined;
}
