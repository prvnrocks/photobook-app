// magazine/portrait layouts (M30, D-090). Pure data, original artwork. Append-only order (AI catalogue /
// prompt cache): the auto cover first, then single pages by photo count, then spreads; later
// additions at the end. Registered at the end of src/lib/layouts/index.ts — builders only edit this
// directory.
//
// MAGAZINE_PORTRAIT_LAYOUTS: role "cover" (the ONE auto-picked cover), "page" (1–6 photos) and "spread"
//   (with twin: [left, right] page ids from this same list).
// MAGAZINE_PORTRAIT_COVERS: the user-chosen cover styles — role "cover", autoPick: false, id containing
//   "-cover-", name starting "Cover: " (same rules as the M29 covers).
// Every entry: style "magazine", format "A5_PORTRAIT".
//
// Order within a photo count decides ties in the rule-based pick: a single portrait photo gets the
// full-bleed page, a landscape one the text-column page; the chapter openers come after them.

import type { Layout } from "@/lib/book/types";
import {
  magazinePortraitCover,
  magazinePortraitCoverBand,
  magazinePortraitCoverSplit,
  magazinePortraitCoverWindow,
} from "./covers";
import {
  magazinePortraitFiveHero,
  magazinePortraitFourHero,
  magazinePortraitFourStrip,
  magazinePortraitFull,
  magazinePortraitOneColumn,
  magazinePortraitOneHeadline,
  magazinePortraitSixHero,
  magazinePortraitSpreadFeature,
  magazinePortraitSpreadPanorama,
  magazinePortraitThreeFeature,
  magazinePortraitThreeHero,
  magazinePortraitTwoCircle,
  magazinePortraitTwoPanel,
} from "./layouts";

export const MAGAZINE_PORTRAIT_LAYOUTS: readonly Layout[] = [
  magazinePortraitCover,
  magazinePortraitFull,
  magazinePortraitOneColumn,
  magazinePortraitOneHeadline,
  magazinePortraitTwoPanel,
  magazinePortraitTwoCircle,
  magazinePortraitThreeFeature,
  magazinePortraitThreeHero,
  magazinePortraitFourStrip,
  magazinePortraitFourHero,
  magazinePortraitFiveHero,
  magazinePortraitSixHero,
  magazinePortraitSpreadPanorama,
  magazinePortraitSpreadFeature,
];

export const MAGAZINE_PORTRAIT_COVERS: readonly Layout[] = [
  magazinePortraitCoverBand,
  magazinePortraitCoverWindow,
  magazinePortraitCoverSplit,
];
