// magazine/landscape layouts (M30 T5, D-090). Pure data, original artwork. Append-only order (AI catalogue /
// prompt cache): the auto cover first, then single pages by photo count, then spreads; later
// additions at the end. Registered at the end of src/lib/layouts/index.ts.
//
// MAGAZINE_LANDSCAPE_LAYOUTS: role "cover" (the ONE auto-picked cover), "page" (1–6 photos) and "spread"
//   (with twin: [left, right] page ids from this same list).
// MAGAZINE_LANDSCAPE_COVERS: the user-chosen cover styles — role "cover", autoPick: false, id containing
//   "-cover-", name starting "Cover: " (same rules as the M29 covers).
// Every entry: style "magazine", format "A5_LANDSCAPE".

import type { Layout } from "@/lib/book/types";
import {
  magazineLandscapeCover,
  magazineLandscapeCoverBand,
  magazineLandscapeCoverFoot,
  magazineLandscapeCoverPanel,
} from "./covers";
import {
  magazineLandscapeFive,
  magazineLandscapeFourGrid,
  magazineLandscapeFourStrip,
  magazineLandscapeOneBand,
  magazineLandscapeOneColumn,
  magazineLandscapeOneOpener,
  magazineLandscapeSix,
  magazineLandscapeThreeFeature,
  magazineLandscapeThreeHero,
  magazineLandscapeTwoCircle,
  magazineLandscapeTwoPanel,
} from "./pages";
import { magazineLandscapeSpreadFeature, magazineLandscapeSpreadPano } from "./spreads";

export const MAGAZINE_LANDSCAPE_LAYOUTS: readonly Layout[] = [
  magazineLandscapeCover,
  magazineLandscapeOneOpener,
  magazineLandscapeOneBand,
  magazineLandscapeOneColumn,
  magazineLandscapeTwoPanel,
  magazineLandscapeTwoCircle,
  magazineLandscapeThreeHero,
  magazineLandscapeThreeFeature,
  magazineLandscapeFourStrip,
  magazineLandscapeFourGrid,
  magazineLandscapeFive,
  magazineLandscapeSix,
  magazineLandscapeSpreadPano,
  magazineLandscapeSpreadFeature,
];

export const MAGAZINE_LANDSCAPE_COVERS: readonly Layout[] = [
  magazineLandscapeCoverPanel,
  magazineLandscapeCoverBand,
  magazineLandscapeCoverFoot,
];
