// geometric/portrait layouts (M10c T5a). Pure data, original artwork. Append-only order (AI catalogue / prompt cache).
// Cover, then single pages by photo count, then the spread; later additions at the end.

import type { Layout } from "@/lib/book/types";
import {
  geometricPortraitCover,
  geometricPortraitFiveHex,
  geometricPortraitFourPetals,
  geometricPortraitOneBand,
  geometricPortraitSpreadBand,
  geometricPortraitThreeDiamond,
  geometricPortraitTwoCircle,
  geometricPortraitTwoDiag,
  geometricPortraitTwoPair,
} from "./layouts";

export const GEOMETRIC_PORTRAIT_LAYOUTS: readonly Layout[] = [
  geometricPortraitCover,
  geometricPortraitOneBand,
  geometricPortraitTwoDiag,
  geometricPortraitTwoCircle,
  geometricPortraitThreeDiamond,
  geometricPortraitFourPetals,
  geometricPortraitFiveHex,
  geometricPortraitSpreadBand,
  geometricPortraitTwoPair,
];
