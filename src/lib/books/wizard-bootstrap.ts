import "server-only";
// Step-5 data for a book the wizard has just created (M20 T6, D-072): createBookAction returns it so
// the wizard shows "Add your photos" in place without a second request. A brand-new book has no
// photos, no doc and no run, so nothing is read from the database — the same shape loadWizardStep(5)
// would answer with.

import { resolveAiMode } from "@/lib/ai/client";
import { limitsFor } from "@/lib/ai/limits";
import { displayBookTitle } from "@/lib/book/display-title";
import type { CaptionLang } from "@/lib/book/options";
import type { WizardStep5Data } from "./wizard-data";

export function freshBookStep5Data(input: {
  bookId: string;
  userId: string;
  title: string | null;
  occasion: string;
  format: string;
  designStyle: string;
  captionLang: CaptionLang;
}): WizardStep5Data {
  const limits = limitsFor(false);
  return {
    step: 5,
    bookId: input.bookId,
    title: displayBookTitle(input.title, null),
    rawTitle: input.title,
    occasion: input.occasion,
    format: input.format,
    designStyle: input.designStyle,
    captionLang: input.captionLang,
    isPaid: false,
    aiOn: resolveAiMode() !== "off",
    resolved: 5,
    userId: input.userId,
    existing: [],
    maxUpload: limits.maxUploadPhotos,
    readyCount: 0,
    pendingCount: 0,
    hasDoc: false,
    firstRun: "none",
    dailyCap: limits.maxLiveBuildsPerUserPerDay,
  };
}
