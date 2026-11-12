// Book setup after a photos-first start (M13 T2, D-070). Pure: no React/DOM/server imports, so
// the client (setup card) and the server actions share one rule.
//
// D-070 amends D-063: page shape (books.format) and design style (books.design_style) can change
// while the setup is UNLOCKED — the book has no agent_runs row yet (any trigger: no AI build has
// started) AND its doc is not user-edited (`{}` or an untouched rule draft). After that they are
// fixed, as before. Occasion, feel (tone), caption language and title can change until the first
// AI build starts (the AI has read them by then; later changes would silently not apply to the
// album). The server re-checks every rule (src/app/books/actions.ts updateBookSetupAction) — the
// client copy is only for showing / hiding the controls.
// Client-safe and light: the rule-draft rebuild (autolayout + layout catalogue) lives in
// ./rule-draft.ts so importing this guard doesn't ship the layout engine.

import type { CaptionLang, Occasion, Tone } from "@/lib/book/options";
import { docOrigin } from "@/lib/book/replaceable";
import type { BookFormat, DesignStyle } from "@/lib/book/types";

// --- Guard -------------------------------------------------------------------------------------

/** Why a setup field can't change any more; null = it can. */
export type SetupLockReason = "ai_started" | "user_edited";

export type SetupLockInput = {
  /** The book has at least one agent_runs row (any trigger / state). */
  hasRun: boolean;
  /** books.doc as stored. */
  doc: unknown;
};

/**
 * Shape + style (D-070): unlocked only while no AI run exists AND the doc is not user-edited.
 * An unparsable doc counts as user-edited (docOrigin's safe side).
 */
export function designLockReason(input: SetupLockInput): SetupLockReason | null {
  if (input.hasRun) return "ai_started";
  const origin = docOrigin(input.doc);
  if (origin.userEdited) return "user_edited";
  // An AI album without a run row (e.g. the run was deleted) is still past the first build.
  if (origin.generator === "ai") return "ai_started";
  return null;
}

/** Occasion / tone / caption language / title: unlocked until the first AI run exists. */
export function detailsLockReason(input: Pick<SetupLockInput, "hasRun">): SetupLockReason | null {
  return input.hasRun ? "ai_started" : null;
}

export function isDesignUnlocked(input: SetupLockInput): boolean {
  return designLockReason(input) === null;
}

// --- Action contracts (types live here: a "use server" file may only export async functions) ---

export type StartBookInput = {
  /** Page-shape hint from the picked photos (suggestFormat); absent → A5 portrait. */
  format?: BookFormat;
};

export type StartBookResult =
  | {
      ok: true;
      bookId: string;
      /**
       * Where to go next: /books/<id>/upload, with `?_ev=book_created` when analytics is on.
       * Navigate client-side (router.push / replace) — <Analytics> reads the flash on the pathname
       * change and strips it, exactly like createBookAction's redirect.
       */
      next: string;
    }
  | { ok: false; error: "unauthenticated" | "invalid" | "failed" };

export type BookSetupField = "occasion" | "tone" | "captionLang" | "title" | "format" | "designStyle";

export type BookSetupPatch = {
  occasion?: Occasion;
  tone?: Tone;
  captionLang?: CaptionLang;
  /** null clears it (the AI suggests one). */
  title?: string | null;
  format?: BookFormat;
  designStyle?: DesignStyle;
};

/** The setup as stored after the update. */
export type BookSetup = {
  occasion: Occasion;
  tone: Tone;
  captionLang: CaptionLang;
  title: string | null;
  format: BookFormat;
  designStyle: DesignStyle;
};

export type UpdateBookSetupResult =
  | {
      ok: true;
      setup: BookSetup;
      /** True when the rule draft album was re-laid out (refresh any draft preview). */
      relaidOut: boolean;
    }
  | {
      ok: false;
      error:
        | "unauthenticated"
        | "not_found"
        | "invalid"
        /** The field can't change any more (see `reason`). */
        | "locked"
        /** The book changed meanwhile (e.g. an upload finished laying out the draft) — retry. */
        | "conflict"
        | "failed";
      reason?: SetupLockReason;
      fieldErrors?: Partial<Record<BookSetupField, string>>;
    };
