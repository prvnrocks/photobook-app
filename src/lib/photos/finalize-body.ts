// POST /api/books/[id]/finalize request body (M10c). Kept out of route.ts (Next only allows
// route exports there). Colours are user data derived from photos — never log them with ids.
import { z } from "zod";
import { PHOTO_COLOR_RE } from "@/lib/image/color";
import { isUuid } from "@/lib/uuid";

/** Max colour entries per request (= the paid photo cap). */
export const MAX_COLORS = 500;
/** 500 × ~50 bytes ≈ 25 KB; anything far bigger isn't ours. */
export const MAX_BODY_BYTES = 64 * 1024;

export const FinalizeBodySchema = z
  .object({
    colors: z
      .record(
        z.string().refine(isUuid, "photo id must be a uuid"),
        z.string().regex(PHOTO_COLOR_RE, "colour must be #rrggbb"),
      )
      .refine((c) => Object.keys(c).length <= MAX_COLORS, `at most ${MAX_COLORS} colours`)
      .optional(),
  })
  .strict();

export type FinalizeBody = z.infer<typeof FinalizeBodySchema>;

