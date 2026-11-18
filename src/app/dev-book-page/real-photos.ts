// Dev-only: real photographs for the contact sheets (`/dev-book-page?sheet=…&photos=real`, M30 G0),
// so text-over-photo legibility and crops can be judged — the default placeholders are flat colour.
// The files live in `public/dev-photos/` (git-ignored, never committed, never user photos): free
// photographs from picsum.photos, fetched once with
//   curl -L https://picsum.photos/id/<id>/1600/1067 -o public/dev-photos/<id>.jpg   (landscape ids)
//   curl -L https://picsum.photos/id/<id>/1067/1600 -o public/dev-photos/<id>.jpg   (portrait ids)
// A missing folder just shows broken images on the sheet; nothing else reads this file.

import type { RenderPhoto, RenderPhotos } from "@/components/book/BookPage";

const L = [1600, 1067] as const;
const P = [1067, 1600] as const;

/** Cover photos, one per cover on a sheet: light sky, snow + sky, pale beach, busy dark portrait. */
const COVERS: readonly (readonly [number, readonly [number, number]])[] = [
  [447, L],
  [1036, L],
  [1001, L],
  [823, P],
];

/** Slot photos: travel, people, family- and wedding-like scenes; busy, very light and very dark. */
const SLOTS: readonly (readonly [number, readonly [number, number]])[] = [
  [1015, L], // fjord, busy mid-tones
  [838, P], // parent + child in a street
  [342, L], // busy market street
  [325, P], // white dress in a forest, dark
  [177, L], // hiker, hazy and light
  [274, L], // city at night, dark + busy
  [1012, L], // couple in the grass
  [64, P], // portrait, bright backlight
  [829, L], // red canyon
  [1055, L], // near-white beach
  [856, L], // suit and pocket square
  [1022, P], // aurora, very dark
  [1040, L], // castle in green hills
  [513, L], // people at a café
];

const photo = ([id, [width, height]]: (typeof SLOTS)[number]): RenderPhoto => ({ url: `/dev-photos/${id}.jpg`, width, height });

/** How many slot ids (`sp0…`) one sheet item can use (largest M30 layout has 6 photos; headroom). */
const MAX_SLOTS = 12;

/**
 * Photos for the `itemIndex`-th item of a sheet whose `coverIndex`-th cover it is (0 for pages):
 * `d0` = the cover photo, `sp0…` = slot photos. Each item starts at a different photo so the same
 * picture does not repeat across the sheet and every layout meets light, dark and busy photos.
 */
export function realSheetPhotos(itemIndex: number, coverIndex: number): RenderPhotos {
  const out: Record<string, RenderPhoto> = { d0: photo(COVERS[coverIndex % COVERS.length]) };
  for (let k = 0; k < MAX_SLOTS; k++) out[`sp${k}`] = photo(SLOTS[(itemIndex * 5 + k) % SLOTS.length]);
  return out;
}
