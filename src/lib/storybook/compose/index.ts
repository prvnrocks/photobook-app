// Balanced Storybook page composition (Task 7) — the pure engine. Server entry point:
// composeStorybookPages in src/lib/ai/story/compose.ts.
export { composeStoryDoc, measureBalance, splitAtSentence, slotElementId, docPageId, docChapterId, textElementId, COMPOSE_VERSION, MVP_PAGES } from "./compose";
export type { ComposeInput, ComposeResult, ComposeReport, ComposeBalance } from "./compose";
export { selectPageTemplate, placeTexts, textFits, cropLoss, cutsSubject, slotDpi, photoShape, cropFor, CROP_REJECT, CROP_WARN, SUBJECT_EDGE, CAPACITY_SLACK, REPEAT_WINDOW } from "./select";
export { validatePageLayout } from "./validate";
export type { ValidatePageContext } from "./validate";
export { userOwnedElements, mergeComposition, pageHash, chapterHash, coverHash, pageKey, chapterKey, coverKey } from "./merge";
export type { UserOwned, OwnershipResult } from "./merge";
export { replacePhotoAndRelayout } from "./relayout";
export type { ReplacePhotoResult, ReplacePhotoContext } from "./relayout";
export { contentHash, stableJson } from "./hash";
export * from "./types";
