// Which wizard step a hard load / refresh may show (M20 T1, D-072, guardrails G2 + G3). Pure and
// dependency-free (no zod, no docOrigin import): first-load client islands may import it directly.
// The server pre-computes every input (docOrigin / detailsLockReason need the book schema) —
// src/lib/books/wizard-data.ts does that for GET /api/books/[id]/wizard and /books/new.
// Also re-exported from ./wizard-routes for server callers.

/** Steps of the M20 wizard: 1–4 form (Title, Purpose, Shape, Style), 5 Photos, 6 Sorting, 7 Review. */
export type WizardRequestStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Where to go: a wizard step, the editor (user-edited album), or "classic" — the non-wizard build
 * screen (/books/[id]/build): only a running rebuild. M20b: a first build with AI switched off (the
 * rule build) runs in the wizard too — steps 6 Sorting and 7 Review in every AI mode.
 */
export type WizardTarget = WizardRequestStep | "editor" | "classic";

/** Same values as SetupLockReason in src/lib/book/setup.ts (kept structural: no import). */
export type WizardDetailsLock = "ai_started" | "user_edited";

export type WizardGateInput = {
  /** The step the URL / client asked for. Out-of-range values are clamped to 1..7. */
  requested: number;
  /** The book has at least one agent_runs row (any trigger / state). */
  hasRun: boolean;
  /** An active (not done / failed) build run exists. */
  active: boolean;
  /** Trigger of the active run, when known. A running rebuild shows the classic build screen. */
  activeTrigger?: "build" | "rebuild" | null;
  /**
   * A run read failed: whether a run exists / is active is unknown. Step ≥6 then keeps today's
   * behaviour (step 6 POSTs; the server answers 409 already_running + runId for a queued run).
   */
  readError: boolean;
  /** detailsLockReason({ hasRun, doc }) — null while steps 1–4 may still change the setup. */
  detailsLock: WizardDetailsLock | null;
  /**
   * docOrigin(books.doc).generator, and userEdited = albumEditedByUser(books.doc) (editor save,
   * a user caption or a user background; an unparsable doc counts as edited).
   */
  docOrigin: { generator: "ai" | "rule" | "none"; userEdited: boolean };
  /**
   * books.album_confirmed_at is set (M20c, migration 2000): the user pressed "Generate album" — the
   * book never shows the wizard again, whatever step is asked (→ "editor").
   */
  albumConfirmed: boolean;
  /**
   * resolveAiMode() !== "off". Informational since M20b: AI off no longer changes the answer (a first
   * rule build shows step 6 / 7 like an AI build; only a running rebuild is "classic").
   */
  aiOn?: boolean;
};

/** books.album_confirmed_at → WizardGateInput.albumConfirmed (a non-empty timestamp string = confirmed). */
export function albumConfirmedOf(albumConfirmedAt: unknown): boolean {
  return typeof albumConfirmedAt === "string" && albumConfirmedAt.length > 0;
}

function clampStep(n: number): WizardRequestStep {
  if (!Number.isFinite(n)) return 1;
  return Math.min(7, Math.max(1, Math.trunc(n))) as WizardRequestStep;
}

/**
 * G3 + G2 decision table (first match wins):
 *  1. user-edited album                         → "editor" (the wizard never shows an edited book)
 *  1b. album confirmed ("Generate album" ran)   → "editor" for every requested step (M20c) — also
 *                                                 over an active run: the editor's own redirect
 *                                                 sends a running build / rebuild to /books/[id]/build
 *                                                 (classic for a rebuild), never back here
 *  2. active run                                → 6 ("classic" for a rebuild) — resume, never
 *                                                 start a 2nd run (AI off too, M20b)
 *  3. run read error                            → requested ≤5 with details unlocked: requested
 *                                                 (the upload page's "unknown = no run");
 *                                                 otherwise 6 (today's build-page POST path)
 *  4. finished run (exists, none active)        → 7 (Review)
 *  5. no run but details locked (an AI album whose run row is gone) → 7
 *  6. no run, requested ≤5                      → requested (steps 1–5 still editable)
 *  7. no run, requested ≥6                      → 6 (may start the first build via the existing
 *                                                 auto-build / build POST path; a rule run when AI off)
 * Steps 1–4 locking once a photo is picked (G2 first half) is client state — wizard-flow.ts.
 */
export function resolveWizardStep(input: WizardGateInput): WizardTarget {
  const requested = clampStep(input.requested);
  // M20b: the sorting step for every first build, AI on or off (only rebuilds stay classic).
  const buildScreen: WizardTarget = 6;

  if (input.docOrigin.userEdited || input.detailsLock === "user_edited") return "editor";
  if (input.albumConfirmed) return "editor";
  if (input.active) return input.activeTrigger === "rebuild" ? "classic" : buildScreen;
  if (input.readError) return requested <= 5 && input.detailsLock === null ? requested : buildScreen;
  if (input.hasRun) return 7;
  if (input.detailsLock !== null) return 7;
  if (requested <= 5) return requested;
  return buildScreen;
}
