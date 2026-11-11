// M10c review S1 (D-062): a doc with an AI faded-photo background (chapter opener) and a
// user-picked photo background, both using photo DROPPED. Shared by the privacy-prune tests.
import { fadedPhotoBackground } from "@/lib/design/background-suggest";

export const KEPT_A = "a1111111-1111-4111-8111-111111111111";
export const KEPT_B = "b2222222-2222-4222-8222-222222222222";
export const DROPPED = "d3333333-3333-4333-8333-333333333333";
export const USER_PICK = "e4444444-4444-4444-8444-444444444444";

const crop = { x: 0.5, y: 0.5, zoom: 1 };

export function fadedBackgroundDoc(opts: { userEdited?: boolean; aiBookBackground?: boolean } = {}) {
  return {
    version: 2,
    format: "A5_PORTRAIT",
    occasion: "family",
    cover: { layout: "cover", photoId: KEPT_A, title: "Family", subtitle: "" },
    chapters: [{ id: "c1", title: "Garden", dateLabel: "Oct 2026", place: null }],
    pages: [
      {
        id: "p1",
        chapterId: "c1",
        layout: "one-portrait",
        slots: [{ photoId: KEPT_A, crop }],
        caption: null,
        background: { ...fadedPhotoBackground(DROPPED), source: "ai" },
      },
      {
        id: "p2",
        chapterId: "c1",
        layout: "one-portrait",
        slots: [{ photoId: KEPT_B, crop }],
        caption: null,
        background: { ...fadedPhotoBackground(USER_PICK), source: "user" },
      },
    ],
    style: {
      background: opts.aiBookBackground ? fadedPhotoBackground(DROPPED) : { kind: "color", hex: "#FFFFFF" },
      ...(opts.aiBookBackground ? { backgroundSource: "ai" } : {}),
      designStyle: "classic",
      font: "Playfair",
    },
    meta: { generator: "ai", generatorVersion: 1, runId: null, userEdited: opts.userEdited === true },
  };
}

/** Review statuses: DROPPED and USER_PICK are dropped (the user pick may use a dropped photo). */
export const PHOTO_STATUSES = [
  { id: KEPT_A, status: "kept" },
  { id: KEPT_B, status: "kept" },
  { id: DROPPED, status: "dropped" },
  { id: USER_PICK, status: "dropped" },
];
