// geometric/landscape layouts (M10c T5b). Pure data, original artwork. Append-only order (AI catalogue / prompt cache).
// Cover, then single pages by photo count, then the spread; later additions at the end.

import type { Layout } from "@/lib/book/types";
import {
  geometricLandscapeCover,
  geometricLandscapeFiveHex,
  geometricLandscapeFourPetals,
  geometricLandscapeOneBand,
  geometricLandscapeSpreadBand,
  geometricLandscapeThreeDiamond,
  geometricLandscapeTwoCircle,
  geometricLandscapeTwoDiag,
} from "./layouts";

export const GEOMETRIC_LANDSCAPE_LAYOUTS: readonly Layout[] = [
  geometricLandscapeCover,
  geometricLandscapeOneBand,
  geometricLandscapeTwoDiag,
  geometricLandscapeTwoCircle,
  geometricLandscapeThreeDiamond,
  geometricLandscapeFourPetals,
  geometricLandscapeFiveHex,
  geometricLandscapeSpreadBand,
];
