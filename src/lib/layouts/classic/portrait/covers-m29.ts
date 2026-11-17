// M29 cover styles — classic A5 portrait (D-080). Pure data, appended to LAYOUTS after every
// earlier layout (index.ts); the frozen M10 arrays are never touched.
//
// Rules for every entry (enforced by tests/layouts-covers.test.ts → tests/helpers/cover-rules.ts):
// role "cover", style "classic", format "A5_PORTRAIT", autoPick: false (user-chosen in the editor only —
// never by the build, the AI or bestCoverLayout), exactly one photo slot (photoCount 1), texts with
// one coverTitle + one coverSubtitle box, every text ≥ SAFE_MM (4 mm) inside the trim, landscape
// titles ≥ 10 mm from the spine (left) edge, no text over the photo slot unless it sits on a plate,
// id unique and containing "-cover-", name starting "Cover: ". Existing drawing primitives only.

import type { Layout } from "@/lib/book/types";

export const CLASSIC_PORTRAIT_COVERS = [] as const satisfies readonly Layout[];
