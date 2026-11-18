// editorial/portrait layouts (M30, D-090). Pure data, original artwork. Append-only order (AI catalogue /
// prompt cache): the auto cover first, then single pages by photo count, then spreads; later
// additions at the end. Registered at the end of src/lib/layouts/index.ts.
//
// EDITORIAL_PORTRAIT_LAYOUTS: role "cover" (the ONE auto-picked cover), "page" (1–6 photos) and "spread"
//   (with twin: [left, right] page ids from this same list).
// EDITORIAL_PORTRAIT_COVERS: the user-chosen cover styles — role "cover", autoPick: false, id containing
//   "-cover-", name starting "Cover: " (same rules as the M29 covers).
// Every entry: style "editorial", format "A5_PORTRAIT".

import type { Layout } from "@/lib/book/types";
import { editorialPortraitCoverCorner, editorialPortraitCoverFrame, editorialPortraitCoverVertical } from "./covers-m30";
import {
  editorialPortraitCover,
  editorialPortraitFiveGrid,
  editorialPortraitFourStagger,
  editorialPortraitOneColumn,
  editorialPortraitOneDiagonal,
  editorialPortraitOneOpener,
  editorialPortraitOneStrip,
  editorialPortraitSixGrid,
  editorialPortraitSpreadOpener,
  editorialPortraitSpreadPanorama,
  editorialPortraitThreeColumn,
  editorialPortraitThreeDiagonal,
  editorialPortraitTwoDiagonal,
  editorialPortraitTwoOpener,
  editorialPortraitTwoStack,
} from "./layouts";

export const EDITORIAL_PORTRAIT_LAYOUTS: readonly Layout[] = [
  editorialPortraitCover,
  editorialPortraitOneOpener,
  editorialPortraitOneColumn,
  editorialPortraitOneDiagonal,
  editorialPortraitOneStrip,
  editorialPortraitTwoDiagonal,
  editorialPortraitTwoStack,
  editorialPortraitTwoOpener,
  editorialPortraitThreeColumn,
  editorialPortraitThreeDiagonal,
  editorialPortraitFourStagger,
  editorialPortraitFiveGrid,
  editorialPortraitSixGrid,
  editorialPortraitSpreadPanorama,
  editorialPortraitSpreadOpener,
];

export const EDITORIAL_PORTRAIT_COVERS: readonly Layout[] = [
  editorialPortraitCoverVertical,
  editorialPortraitCoverCorner,
  editorialPortraitCoverFrame,
];
