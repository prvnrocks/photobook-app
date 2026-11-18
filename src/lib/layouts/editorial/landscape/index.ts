// editorial/landscape layouts (M30 T7, D-090). Pure data, original artwork. Append-only order (AI
// catalogue / prompt cache): the auto cover first, then single pages by photo count, then spreads;
// later additions at the end. Registered at the end of src/lib/layouts/index.ts.
//
// EDITORIAL_LANDSCAPE_LAYOUTS: role "cover" (the ONE auto-picked cover), "page" (1–6 photos) and "spread"
//   (with twin: [left, right] page ids from this same list).
// EDITORIAL_LANDSCAPE_COVERS: the user-chosen cover styles — role "cover", autoPick: false, id containing
//   "-cover-", name starting "Cover: " (same rules as the M29 covers).
// Every entry: style "editorial", format "A5_LANDSCAPE".

import type { Layout } from "@/lib/book/types";
import {
  editorialLandscapeCover,
  editorialLandscapeCoverBleed,
  editorialLandscapeCoverCorner,
  editorialLandscapeCoverFrame,
} from "./covers";
import {
  editorialLandscapeFiveGrid,
  editorialLandscapeFourGrid,
  editorialLandscapeOneBleed,
  editorialLandscapeOneDiagonal,
  editorialLandscapeOneWide,
  editorialLandscapeSixGrid,
  editorialLandscapeThreeGrid,
  editorialLandscapeThreeRow,
  editorialLandscapeTwoDiagonal,
  editorialLandscapeTwoNotes,
} from "./pages";
import { editorialLandscapeSpreadOpener, editorialLandscapeSpreadPano } from "./spreads";

export const EDITORIAL_LANDSCAPE_LAYOUTS: readonly Layout[] = [
  editorialLandscapeCover,
  editorialLandscapeOneDiagonal,
  editorialLandscapeOneWide,
  editorialLandscapeOneBleed,
  editorialLandscapeTwoDiagonal,
  editorialLandscapeTwoNotes,
  editorialLandscapeThreeGrid,
  editorialLandscapeThreeRow,
  editorialLandscapeFourGrid,
  editorialLandscapeFiveGrid,
  editorialLandscapeSixGrid,
  editorialLandscapeSpreadPano,
  editorialLandscapeSpreadOpener,
];

export const EDITORIAL_LANDSCAPE_COVERS: readonly Layout[] = [
  editorialLandscapeCoverBleed,
  editorialLandscapeCoverCorner,
  editorialLandscapeCoverFrame,
];
