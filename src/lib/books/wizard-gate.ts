// Which wizard step a hard load / refresh may show (M20 T1, D-072, guardrails G2 + G3). Pure and
// dependency-free (no zod, no docOrigin import): first-load client islands may import it directly.
// The server pre-computes every input (docOrigin / detailsLockReason need the book schema) —
// src/lib/books/wizard-data.ts does that for GET /api/books/[id]/wizard and /books/new.
// Also re-exported from ./wizard-routes for server callers.

/** Steps of the M20 wizard: 1–4 form (Title, Purpose, Shape, Style), 5 Photos, 6 Sorting, 7 Review. */
export type WizardRequestStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Where to go: a wizard step, the editor (user-edited album), or "classic" — the non-wizard build
 * screen (/books/[id]/build): a running rebuild, or a build with AI switched off (isWizardBuild).
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
  /** resolveAiMode() !== "off". Default true. AI off → the classic build screen, never step 6. */
  aiOn?: boolean;
};

function clampStep(n: number): WizardRequestStep {
  if (!Number.isFinite(n)) return 1;
  return Math.min(7, Math.max(1, Math.trunc(n))) as WizardRequestStep;
}

/**
 * G3 + G2 decision table (first match wins):
 *  1. user-edited album                         → "editor" (the wizard never shows an edited book)
 *  2. active run                                → 6 ("classic" for a rebuild or AI off) — resume,
 *                                                 never start a 2nd run
 *  3. run read error                            → requested ≤5 with details unlocked: requested
 *                                                 (the upload page's "unknown = no run");
 *                                                 otherwise 6 (today's build-page POST path)
 *  4. finished run (exists, none active)        → 7 (Review)
 *  5. no run but details locked (an AI album whose run row is gone) → 7
 *  6. no run, requested ≤5                      → requested (steps 1–5 still editable)
 *  7. no run, requested ≥6                      → 6 (may start the first build via the existing
 *                                                 auto-build / build POST path; "classic" when AI off)
 * Steps 1–4 locking once a photo is picked (G2 first half) is client state — wizard-flow.ts.
 */
export function resolveWizardStep(input: WizardGateInput): WizardTarget {
  const requested = clampStep(input.requested);
  const aiOn = input.aiOn !== false;
  const buildScreen: WizardTarget = aiOn ? 6 : "classic";

  if (input.docOrigin.userEdited || input.detailsLock === "user_edited") return "editor";
  if (input.active) return input.activeTrigger === "rebuild" ? "classic" : buildScreen;
  if (input.readError) return requested <= 5 && input.detailsLock === null ? requested : buildScreen;
  if (input.hasRun) return 7;
  if (input.detailsLock !== null) return 7;
  if (requested <= 5) return requested;
  return buildScreen;
}
