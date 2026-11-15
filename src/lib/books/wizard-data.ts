import "server-only";
// Data for the wizard's steps 5–7 (M20 T1, D-072): steps 5 Photos, 6 Sorting and 7 Review run
// inside /books/new and load what the classic upload / build / review pages compute, through the
// same helpers (./step-data.ts). Served by GET /api/books/[id]/wizard?step=5|6|7 and used by the
// /books/new page on a hard load. JSON-safe (plain objects, strings, numbers, booleans, null).
// Never carries AI descriptions or storage paths (tiles are ReviewTilePhoto; thumbs are signed URLs).

import type { User } from "@supabase/supabase-js";
import { resolveAiMode } from "@/lib/ai/client";
import { limitsFor } from "@/lib/ai/limits";
import { getCurrentUser } from "@/lib/auth/current-user";
import { displayBookTitle } from "@/lib/book/display-title";
import { CAPTION_LANGS, type CaptionLang } from "@/lib/book/options";
import { docOrigin } from "@/lib/book/replaceable";
import { detailsLockReason } from "@/lib/book/setup";
import { getActiveRunForBook, hasAnyRunForBook, type OwnerRun } from "@/lib/db/agent-runs";
import { getMyBook, type MyBook } from "@/lib/db/books";
import { touchWarnedDraft } from "@/lib/db/draft-activity";
import { listUploadState } from "@/lib/db/photos";
import { albumEditedByUser, countKept, type CaptionsPreviewDoc, type RebuildVariant, type ReviewBanner, type ReviewTilePhoto } from "@/lib/review/ui";
import type { FirstRunState } from "@/lib/upload/auto-build-client";
import type { ExistingPhoto } from "@/lib/upload/queue";
import {
  coverPhotoIdOf,
  docHasContent,
  draftDoc,
  loadFanUrls,
  loadReviewState,
  uploadExisting,
} from "./step-data";
import { resolveWizardStep, type WizardGateInput, type WizardTarget } from "./wizard-gate";

/** Steps whose data comes from the server (1–4 are the client form). */
export const WIZARD_DATA_STEPS = [5, 6, 7] as const;
export type WizardDataStep = (typeof WIZARD_DATA_STEPS)[number];

export function isWizardDataStep(v: unknown): v is WizardDataStep {
  return v === 5 || v === 6 || v === 7;
}

/** Parses `?step=` ("5" | "6" | "7" exactly) → the step, else null. */
export function parseWizardDataStep(raw: string | null | undefined): WizardDataStep | null {
  if (raw === "5") return 5;
  if (raw === "6") return 6;
  if (raw === "7") return 7;
  return null;
}

/** Fields every step answers with. */
export type WizardStepBase = {
  bookId: string;
  /** displayBookTitle(books.title, books.doc) — the title as shown everywhere else. */
  title: string;
  /** books.title as stored (null = the AI suggests one). */
  rawTitle: string | null;
  occasion: string | null;
  /** books.format / design_style (null only before migration 1900). */
  format: string | null;
  designStyle: string | null;
  captionLang: CaptionLang;
  isPaid: boolean;
  aiOn: boolean;
  /** resolveWizardStep for the requested step from this load's reads (G2 + G3). */
  resolved: WizardTarget;
};

/** Step 5 — what /books/[id]/upload passes to <Uploader> (plus the base fields). */
export type WizardStep5Data = WizardStepBase & {
  step: 5;
  userId: string;
  existing: ExistingPhoto[];
  maxUpload: number;
  readyCount: number;
  pendingCount: number;
  hasDoc: boolean;
  firstRun: FirstRunState;
  dailyCap: number;
};

/** Step 6 — what /books/[id]/build passes to <BuildProgress variant="wizard"> + <PhotoFan>. */
export type WizardStep6Data = WizardStepBase & {
  step: 6;
  activeRunId: string | null;
  /** The active-run read failed (≠ "no run"): BuildProgress POSTs and the server decides (409 already_running). */
  readError: boolean;
  trigger: "build";
  dailyCap: number;
  /** Passed through from ?auto=1 (the photos step started the automatic first build). */
  auto: boolean;
  /** Signed 512 px thumbs of the draft's first photos (cover first); [] without a draft. */
  fanUrls: string[];
};

/** Step 7 — what /books/[id]/review computes for ReviewBody / ReviewGrid / CaptionsPreview. */
export type WizardStep7Data = WizardStepBase & {
  step: 7;
  photos: ReviewTilePhoto[];
  albumPhotoIds: string[];
  aiUsed: boolean;
  userEdited: boolean;
  building: boolean;
  /** null while a run is active (as on the review page). */
  rebuild: { variant: RebuildVariant; rebuildsLeft: number | null } | null;
  captionsPreview: CaptionsPreviewDoc;
  banner: ReviewBanner;
  captionsNote: string | null;
  /** The album cover's photo id (books.doc cover), null when none. */
  coverPhotoId: string | null;
  counts: { kept: number; total: number };
};

export type WizardStepData = WizardStep5Data | WizardStep6Data | WizardStep7Data;

export type LoadWizardStepOptions = {
  /** Step 6: ?auto=1. */
  auto?: boolean;
  /** Already loaded by the caller (skips the reads; ownership must have been checked with getMyBook). */
  user?: Pick<User, "id">;
  book?: MyBook;
};

function captionLangOf(v: string | null): CaptionLang {
  return (CAPTION_LANGS as readonly string[]).includes(v ?? "") ? (v as CaptionLang) : "en";
}

function baseOf(book: MyBook, aiOn: boolean, resolved: WizardTarget): WizardStepBase {
  return {
    bookId: book.id,
    title: displayBookTitle(book.title, book.doc),
    rawTitle: book.title,
    occasion: book.occasion,
    format: book.format,
    designStyle: book.design_style,
    captionLang: captionLangOf(book.caption_lang),
    isPaid: book.is_paid,
    aiOn,
    resolved,
  };
}

function gate(
  book: MyBook,
  requested: WizardDataStep,
  runs: { hasRun: boolean; active: OwnerRun | null; readError: boolean },
  aiOn: boolean,
): WizardTarget {
  const { generator } = docOrigin(book.doc);
  const input: WizardGateInput = {
    requested,
    hasRun: runs.hasRun || runs.active !== null,
    active: runs.active !== null,
    activeTrigger: runs.active?.trigger === "rebuild" ? "rebuild" : runs.active ? "build" : null,
    readError: runs.readError,
    detailsLock: detailsLockReason({ hasRun: runs.hasRun || runs.active !== null, doc: book.doc }),
    docOrigin: { generator, userEdited: albumEditedByUser(book.doc) },
    aiOn,
  };
  return resolveWizardStep(input);
}

type Settled<T> = { ok: true; value: T } | { ok: false };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  );
}

async function step5(book: MyBook, userId: string, aiOn: boolean): Promise<WizardStep5Data> {
  // Same reads as the upload page: a run read error counts as "no run" for the Uploader (the
  // server still decides: auto start → not_first); `resolved` keeps it apart as readError.
  const [rows, hasRunRead, activeRead] = await Promise.all([
    listUploadState(book.id),
    settle(hasAnyRunForBook(book.id)),
    settle(getActiveRunForBook(book.id)),
  ]);
  const hasRun = hasRunRead.ok ? hasRunRead.value : false;
  const active = activeRead.ok ? activeRead.value : null;
  const { existing, readyCount, pendingCount } = uploadExisting(rows);
  const firstRun: FirstRunState = active ? "active" : hasRun ? "done" : "none";
  const limits = limitsFor(book.is_paid);
  return {
    ...baseOf(book, aiOn, gate(book, 5, { hasRun, active, readError: !hasRunRead.ok || !activeRead.ok }, aiOn)),
    step: 5,
    userId,
    existing,
    maxUpload: limits.maxUploadPhotos,
    readyCount,
    pendingCount,
    hasDoc: docHasContent(book.doc),
    firstRun,
    dailyCap: limits.maxLiveBuildsPerUserPerDay,
  };
}

async function step6(book: MyBook, aiOn: boolean, auto: boolean): Promise<WizardStep6Data> {
  // A read error is not "no run" (build page): keep it apart so ?auto=1 never strands a queued run.
  const [activeRead, hasRunRead, fanUrls] = await Promise.all([
    settle(getActiveRunForBook(book.id)),
    settle(hasAnyRunForBook(book.id)),
    loadFanUrls(book.id, draftDoc(book.doc)),
  ]);
  const active = activeRead.ok ? activeRead.value : null;
  const hasRun = hasRunRead.ok ? hasRunRead.value : false;
  const readError = !activeRead.ok || !hasRunRead.ok;
  return {
    ...baseOf(book, aiOn, gate(book, 6, { hasRun, active, readError }, aiOn)),
    step: 6,
    activeRunId: active?.id ?? null,
    readError: !activeRead.ok,
    trigger: "build",
    dailyCap: limitsFor(book.is_paid).maxLiveBuildsPerUserPerDay,
    auto,
    fanUrls,
  };
}

async function step7(book: MyBook, userId: string, aiOn: boolean): Promise<WizardStep7Data> {
  // Owner opened a warned draft: counts as activity (review page, review S3). Never throws.
  // Once per load, after the ownership check — exactly like the review page.
  await touchWarnedDraft(book.id, userId);
  // Review reads throw on error (→ 503 / error boundary, as on the review page), so the active
  // run is known here. The extra run-exists read for the gate is best effort: unknown counts as
  // "a run exists" — step 7 was asked for and loaded, and bouncing to step 6 could POST a build.
  const [review, hasRunRead] = await Promise.all([
    loadReviewState(book, resolveAiMode()),
    settle(hasAnyRunForBook(book.id)),
  ]);
  const hasRun = hasRunRead.ok ? hasRunRead.value : true;
  const resolved = gate(book, 7, { hasRun, active: review.activeRun, readError: false }, aiOn);
  return {
    ...baseOf(book, aiOn, resolved),
    step: 7,
    photos: review.tiles,
    albumPhotoIds: review.albumPhotoIds,
    aiUsed: review.aiUsed,
    userEdited: review.userEdited,
    building: review.activeRun !== null,
    rebuild: review.activeRun ? null : { variant: review.variant, rebuildsLeft: review.rebuildsLeft },
    captionsPreview: review.captionsPreview,
    banner: review.banner,
    captionsNote: review.captionsNote,
    coverPhotoId: coverPhotoIdOf(book.doc),
    counts: { kept: countKept(review.tiles), total: review.tiles.length },
  };
}

/**
 * Data for wizard step 5, 6 or 7 of the signed-in user's book; null when signed out or the book
 * isn't theirs (or doesn't exist). Throws on DB errors the classic page would also fail on (a
 * Supabase timeout → the route's 503).
 */
export async function loadWizardStep(
  bookId: string,
  step: WizardDataStep,
  opts: LoadWizardStepOptions = {},
): Promise<WizardStepData | null> {
  const user = opts.user ?? (await getCurrentUser());
  if (!user) return null;
  const book = opts.book ?? (await getMyBook(bookId));
  if (!book || book.id !== bookId) return null;
  const aiOn = resolveAiMode() !== "off";
  if (step === 5) return step5(book, user.id, aiOn);
  if (step === 6) return step6(book, aiOn, opts.auto === true);
  return step7(book, user.id, aiOn);
}
