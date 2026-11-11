// classic/landscape layouts (M10b A5). Pure data, original artwork. Append-only order (AI catalogue / prompt cache).
// Same order as the classic portrait catalogue: cover, full page, 1, 2 side by side, 2 stacked, 3, 4.
import type { Layout } from "@/lib/book/types";
import {
  classicLandscapeCover,
  classicLandscapeFourGrid,
  classicLandscapeFullPage,
  classicLandscapeOnePhoto,
  classicLandscapeThreeMixed,
  classicLandscapeTwoSide,
  classicLandscapeTwoStacked,
} from "./layouts";

export const CLASSIC_LANDSCAPE_LAYOUTS: readonly Layout[] = [
  classicLandscapeCover,
  classicLandscapeFullPage,
  classicLandscapeOnePhoto,
  classicLandscapeTwoSide,
  classicLandscapeTwoStacked,
  classicLandscapeThreeMixed,
  classicLandscapeFourGrid,
];
