// modern/landscape layouts (M10b A5). Pure data, original artwork. Append-only order (AI catalogue / prompt cache).
// Covers, then single pages (full bleed first, then by photo count), then spreads; later additions at the end.
import type { Layout } from "@/lib/book/types";
import { modernLandscapeCoverPanel, modernLandscapeCoverStrip } from "./covers";
import {
  modernLandscapeFive,
  modernLandscapeFour,
  modernLandscapeFullBleed,
  modernLandscapeOne,
  modernLandscapeOneText,
  modernLandscapeSix,
  modernLandscapeThree,
  modernLandscapeThreeB,
  modernLandscapeThreeRow,
  modernLandscapeTwo,
  modernLandscapeTwoLand,
} from "./pages";
import { modernLandscapeSpreadGrid, modernLandscapeSpreadMosaic, modernLandscapeSpreadPanorama } from "./spreads";

export const MODERN_LANDSCAPE_LAYOUTS: readonly Layout[] = [
  modernLandscapeCoverStrip,
  modernLandscapeCoverPanel,
  modernLandscapeFullBleed,
  modernLandscapeOne,
  modernLandscapeOneText,
  modernLandscapeTwo,
  modernLandscapeThree,
  modernLandscapeThreeB,
  modernLandscapeThreeRow,
  modernLandscapeFour,
  modernLandscapeFive,
  modernLandscapeSix,
  modernLandscapeSpreadGrid,
  modernLandscapeSpreadMosaic,
  modernLandscapeSpreadPanorama,
  modernLandscapeTwoLand, // appended (catalogue order is append-only)
];
