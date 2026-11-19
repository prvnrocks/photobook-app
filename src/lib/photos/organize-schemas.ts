// Zod schema of the organiser's structured result (Task 4). Pure.

import { z } from "zod";
import { CANDIDATE_ROLES, UNCERTAIN_REASONS } from "./moments";
import { FILTER_REASONS } from "./filter";
import { QUALITY_FLAGS } from "./quality";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const score = z.number().min(0).max(100);
const momentKey = z.string().regex(/^m:[0-9a-f-]{36}$/);

export const PhotoQualitySchema = z
  .object({
    photoId: uuid,
    version: z.number().int().min(1),
    sharpness: score,
    exposure: score,
    composition: score,
    overall: score,
    flags: z.array(z.enum(QUALITY_FLAGS)),
    /** "pixels" = measured on the analysis copy; "blur_score" = sharpness only, from the upload-time score. */
    basis: z.enum(["pixels", "blur_score"]),
  })
  .strict();

export const DuplicateGroupSchema = z
  .object({
    key: uuid,
    kind: z.enum(["exact", "near"]),
    photoIds: z.array(uuid).min(2),
    preferredPhotoId: uuid,
    preferredSource: z.enum(["auto", "user"]),
  })
  .strict()
  .refine((g) => g.photoIds.includes(g.preferredPhotoId), { message: "preferred photo is not in the group", path: ["preferredPhotoId"] });

export const CandidateSchema = z
  .object({
    photoId: uuid,
    momentKey,
    role: z.enum(CANDIDATE_ROLES),
    score,
    reason: z.enum(["duplicate", "blurry", "dropped"]).optional(),
  })
  .strict();

export const MomentGroupSchema = z
  .object({
    key: momentKey,
    position: z.number().int().min(0),
    photoIds: z.array(uuid).min(1),
    label: z.string().min(1).max(160),
    labelSource: z.enum(["auto", "user"]),
    dateLabel: z.string().max(60).nullable(),
    labelEvidence: z.array(
      z
        .object({
          kind: z.enum(["place", "activity", "object", "scene", "date"]),
          source: z.enum(["metadata", "vision", "timestamp"]),
          value: z.string().min(1).max(200),
          support: z.number().int().min(0),
          of: z.number().int().min(1),
        })
        .strict(),
    ),
    startsAt: z.string().datetime().nullable(),
    endsAt: z.string().datetime().nullable(),
    place: z.string().max(200).nullable(),
    heroPhotoId: uuid.nullable(),
    heroSource: z.enum(["auto", "user"]),
    confidence: z.number().min(0).max(1),
    uncertain: z.boolean(),
    uncertainReasons: z.array(z.enum(UNCERTAIN_REASONS)),
  })
  .strict()
  .refine((m) => m.heroPhotoId === null || m.photoIds.includes(m.heroPhotoId), { message: "hero is not in the moment", path: ["heroPhotoId"] });

export const UncertainGroupingSchema = z
  .object({
    kind: z.enum(["boundary", "membership", "moment"]),
    reason: z.enum(UNCERTAIN_REASONS),
    momentKey,
    otherMomentKey: momentKey.optional(),
    photoIds: z.array(uuid),
    score: z.number().optional(),
  })
  .strict();

export const OrganizeResultSchema = z
  .object({
    bookId: uuid,
    photos: z.number().int().min(0),
    quality: z.array(PhotoQualitySchema),
    duplicateGroups: z.array(DuplicateGroupSchema),
    candidates: z.array(CandidateSchema),
    moments: z.array(MomentGroupSchema),
    uncertain: z.array(UncertainGroupingSchema),
    /** Work left for a later call (bounded runs) and data that was not available. */
    pending: z.object({ quality: z.number().int().min(0), vision: z.number().int().min(0) }).strict(),
    /** Kept photos a storybook sets aside (decisions; the storybook job writes photos.status / drop_reason). */
    filters: z.array(z.object({ photoId: uuid, reason: z.enum(FILTER_REASONS) }).strict()),
  })
  .strict()
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.moments.forEach((m, i) =>
      m.photoIds.forEach((id) => {
        if (seen.has(id)) ctx.addIssue({ code: "custom", path: ["moments", i, "photoIds"], message: "a photo is in more than one moment" });
        seen.add(id);
      }),
    );
  });

export type PhotoQuality = z.infer<typeof PhotoQualitySchema>;
export type MomentGroup = z.infer<typeof MomentGroupSchema>;
export type OrganizeResult = z.infer<typeof OrganizeResultSchema>;
